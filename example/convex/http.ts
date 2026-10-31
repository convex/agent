import { httpRouter } from "convex/server";
import { streamOverHttp } from "./chat/streaming";
import { corsRouter } from "convex-helpers/server/cors";
import { batchWebhook } from "./batch/batch";

const http = httpRouter();

const cors = corsRouter(http, {
  allowedHeaders: ["Authorization", "Content-Type"],
  exposedHeaders: ["Content-Type", "Content-Length", "X-Message-Id"],
});

cors.route({
  path: "/streamText",
  method: "POST",
  handler: streamOverHttp,
});

http.route({
  path: "/batchWebhook",
  method: "POST",
  handler: batchWebhook,
});

// Convex expects the router to be the default export of `convex/http.js`.
export default http;
