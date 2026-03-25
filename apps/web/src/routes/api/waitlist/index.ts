import { createFileRoute } from "@tanstack/react-router";
import { getPrisma } from "@/lib/db";
import { sendEmail, waitlistConfirmationEmail } from "@/lib/email";

export const Route = createFileRoute("/api/waitlist/")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        // CORS headers for cross-origin landing page
        const corsHeaders = {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        };

        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        try {
          const body = (await request.json()) as {
            email?: string;
            name?: string;
            role?: string;
            orgName?: string;
          };

          if (!body.email || typeof body.email !== "string") {
            return new Response(
              JSON.stringify({ error: "Email is required" }),
              {
                status: 400,
                headers: {
                  "Content-Type": "application/json",
                  ...corsHeaders,
                },
              }
            );
          }

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
