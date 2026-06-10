import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { sendEmail, waitlistConfirmationEmail } from "@/lib/email";
import { emailSchema } from "@/lib/validation";

const waitlistBodySchema = z.object({
  email: emailSchema,
  name: z.string().max(100).optional(),
  role: z.string().max(50).optional(),
  orgName: z.string().max(200).optional(),
});

export const Route = createFileRoute("/api/waitlist/")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        // Handle CORS preflight — browsers send OPTIONS but TanStack may route as GET
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      },
      POST: async ({ request }: { request: Request }) => {
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };

        try {
          const parsed = waitlistBodySchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) {
            const issue = parsed.error.issues[0];
            return new Response(
              JSON.stringify({ error: issue ? issue.message : "Invalid request body" }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }
          const body = parsed.data;

          const prisma = getPrisma();
          const existing = await prisma.waitlistSignup.findUnique({
            where: { email: body.email },
          });

          if (existing) {
            return new Response(
              JSON.stringify({ alreadyExists: true }),
              {
                status: 200,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }

          await prisma.waitlistSignup.create({
            data: {
              email: body.email,
              name: body.name || "",
              role: body.role || "",
              orgName: body.orgName || "",
            },
          });

          // Send confirmation email (non-blocking)
          try {
            const { subject, html } = waitlistConfirmationEmail(body.name);
            await sendEmail({ to: body.email, subject, html });
          } catch (emailErr) {
            console.error(
              "[waitlist] Failed to send confirmation email:",
              emailErr
            );
          }

          return new Response(
            JSON.stringify({ alreadyExists: false }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        } catch {
          return new Response(
            JSON.stringify({ error: "Internal server error" }),
            {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
              },
            }
          );
        }
      },
    },
  },
});
