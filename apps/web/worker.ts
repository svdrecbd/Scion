import vinext from "vinext/server/fetch-handler";

const canonicalHost = "cellanatomy.org";

const securityHeaders = {
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.hostname === `www.${canonicalHost}`) {
      url.hostname = canonicalHost;
      return new Response(null, {
        status: 308,
        headers: {
          ...securityHeaders,
          Location: url.toString()
        }
      });
    }

    const response = await vinext.fetch(request, env, context);
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries(securityHeaders)) {
      secured.headers.set(name, value);
    }
    return secured;
  }
} satisfies ExportedHandler<Cloudflare.Env>;
