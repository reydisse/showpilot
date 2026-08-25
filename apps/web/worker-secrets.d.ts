/** Secret and dashboard bindings that Wrangler cannot infer from wrangler.jsonc. */
declare namespace Cloudflare {
	interface Env {
		NEXTJS_ENV: string;
		BETTER_AUTH_SECRET: string;
		BETTER_AUTH_URL: string;
		CLOUDFLARE_ACCOUNT_ID: string;
		CLOUDFLARE_STREAM_API_TOKEN: string;
		RESEND_API_KEY: string;
		KIOSK_SECRET: string;
		COMPANION_SECRET: string;
		VAPID_PUBLIC_KEY: string;
		VAPID_PRIVATE_KEY: string;
		VAPID_SUBJECT: string;
		EXPO_ACCESS_TOKEN?: string;
		STRIPE_SECRET_KEY: string;
		STRIPE_WEBHOOK_SECRET: string;
		STRIPE_PRICE_STARTER: string;
		STRIPE_PRICE_PRO: string;
		STRIPE_PRICE_FOUNDING: string;
	}
}
