/**
 * Glue: authenticate the caller, then match the request to an API route, the
 * media directory, or a UI file.
 *
 * Separate from both so that `serve.ts` has one line of HTTP in it and the
 * API module never has to know what a ServerResponse is.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, createApi } from "./api.ts";
import type { ApiDeps } from "./api.ts";
import {
  SESSION_COOKIE,
  clearedCookie,
  digestToken,
  parseCookies,
  sessionCookie,
} from "./auth.ts";
import { serveStatic } from "./static.ts";
import type { Store } from "../store/db.ts";

/**
 * Reachable without a session.
 *
 * Deliberately a short list, written out rather than derived from a prefix:
 * a rule like "anything under /api/auth is public" is one careless filename
 * away from exposing a route nobody meant to.
 *
 * - /health is the readiness probe Ansible and Uptime Kuma call, and it must
 *   answer before anyone has ever logged in.
 * - /api/session tells the UI whether to show setup, login, or the app, so
 *   by definition it is asked by someone with no session.
 * - /api/setup refuses once an account exists; see the route.
 * - /api/login is the login.
 */
const PUBLIC_ROUTES = new Set([
  "GET /health",
  "GET /api/session",
  "POST /api/setup",
  "POST /api/login",
]);

/** The login screen itself has to load before anyone can log in. */
const PUBLIC_FILES = new Set(["/", "/index.html", "/style.css", "/app.js", "/favicon.ico"]);

export interface RouterDeps extends Omit<ApiDeps, "callerOf" | "sessionDigestOf"> {
  store: Store;
  /** Set the Secure flag on the session cookie. On when served over TLS. */
  secureCookies?: boolean;
}

export function createHandler(deps: RouterDeps) {
  const { store, secureCookies = false } = deps;

  const sessionDigestOf = (req: IncomingMessage): string | null => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? digestToken(token) : null;
  };

  const callerOf = (req: IncomingMessage): string | null => {
    const d = sessionDigestOf(req);
    return d ? store.sessionUser(d) : null;
  };

  const { routes, serveMedia, serveThumbnail } = createApi({ ...deps, callerOf, sessionDigestOf });

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const key = `${method} ${url.pathname}`;

    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body, null, 2));
    };

    try {
      const isPublicRoute = PUBLIC_ROUTES.has(key);
      const isPublicFile = method === "GET" && PUBLIC_FILES.has(url.pathname);

      if (!isPublicRoute && !isPublicFile && callerOf(req) === null) {
        // 401 as JSON even for page requests: the UI is a single page that
        // asks /api/session first, so there is nothing to redirect to, and a
        // redirect would turn a fetch into an HTML response the caller
        // cannot parse.
        send(401, { error: "Sign in to continue." }, { "Set-Cookie": clearedCookie(secureCookies) });
        return;
      }

      // One still frame, for the grids.
      if (method === "GET" && url.pathname.startsWith("/thumb/")) {
        await serveThumbnail(decodeURIComponent(url.pathname.slice("/thumb/".length)), res);
        return;
      }

      // The animation itself, for where the animation is the point.
      if (method === "GET" && url.pathname.startsWith("/media/")) {
        await serveMedia(decodeURIComponent(url.pathname.slice("/media/".length)), res);
        return;
      }

      const route = routes[key];
      if (route) {
        const result = (await route(req, url)) as Record<string, unknown>;

        // Routes that start a session hand back a token; turning that into a
        // cookie is the router's job, so no route ever touches a header.
        if (result && typeof result === "object" && typeof result.session === "string") {
          const { session, ...rest } = result;
          send(200, rest, { "Set-Cookie": sessionCookie(session, secureCookies) });
          return;
        }
        if (key === "POST /api/logout") {
          send(200, result, { "Set-Cookie": clearedCookie(secureCookies) });
          return;
        }
        send(200, result);
        return;
      }

      if (method === "GET" && (await serveStatic(url.pathname, res))) return;

      send(404, { error: `No route for ${key}` });
    } catch (error) {
      if (error instanceof HttpError) {
        send(error.status, { error: error.message });
        return;
      }
      // Anything unexpected is still the operator's problem to see, so the
      // message goes to the client as well as the log. This is an
      // authenticated admin tool, not a public service leaking internals.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${new Date().toISOString()}] ${key}: ${message}`);
      send(500, { error: message });
    }
  };
}
