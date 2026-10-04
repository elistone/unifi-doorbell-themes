/**
 * Glue: match a request to an API route, the media directory, or a UI file.
 *
 * Separate from both so that `serve.ts` has one line of HTTP in it and the
 * API module never has to know what a ServerResponse is.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, createApi } from "./api.ts";
import type { ApiDeps } from "./api.ts";
import { serveStatic } from "./static.ts";

export function createHandler(deps: ApiDeps) {
  const { routes, serveMedia } = createApi(deps);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };

    try {
      // Thumbnails: /media/<filename>
      if (method === "GET" && url.pathname.startsWith("/media/")) {
        await serveMedia(decodeURIComponent(url.pathname.slice("/media/".length)), res);
        return;
      }

      const route = routes[`${method} ${url.pathname}`];
      if (route) {
        send(200, await route(req, url));
        return;
      }

      if (method === "GET" && (await serveStatic(url.pathname, res))) return;

      send(404, { error: `No route for ${method} ${url.pathname}` });
    } catch (error) {
      if (error instanceof HttpError) {
        send(error.status, { error: error.message });
        return;
      }
      // Anything unexpected is still the operator's problem to see, so the
      // message goes to the client as well as the log. This is a LAN admin
      // tool, not a public service leaking internals to strangers.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] ${method} ${url.pathname}: ${message}`);
      send(500, { error: message });
    }
  };
}
