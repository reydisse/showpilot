import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getPrisma } from "@/lib/db";
import { sendEmail, waitlistConfirmationEmail } from "@/lib/email";
import { clientIp, isRateLimited } from "@/lib/rate-limit";
import { emailSchema } from "@/lib/validation";

const waitlistBodySchema = z.object({
  email: emailSchema,
  name: z.string().max(100).optional(),
  role: z.string().max(50).optional(),
  orgName: z.string().max(200).optional(),
});

// The landing page is the only browser client that posts here.
const ALLOWED_ORIGINS = ["https://showpilot.tech", "https://www.showpilot.tech"];

function corsOrigin(request: Request): string {
  const origin = request.headers.get("Origin") ?? "";
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

export const Route = createFileRoute("/api/waitlist/")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        // Handle CORS preflight — browsers send OPTIONS but TanStack may route as GET
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": corsOrigin(request),
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            Vary: "Origin",
          },
        });
      },
      POST: async ({ request }: { request: Request }) => {
        const corsHeaders = {
          "Access-Control-Allow-Origin": corsOrigin(request),
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        };

        const ip = clientIp(request);
        if (await isRateLimited(`waitlist:${ip}`, { max: 5, windowSeconds: 3600 })) {
          return new Response(
            JSON.stringify({ error: "Too many requests. Try again later." }),
            {
              status: 429,
              headers: { "Content-Type": "application/json", ...corsHeaders },
            }
          );
        }

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
