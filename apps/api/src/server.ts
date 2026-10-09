import { createLogger } from "@sentra/ts-platform";
import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const logger = createLogger("api");
const { app, internalApp, close } = await createApi(config, logger);

await app.listen({ port: config.port, host: "0.0.0.0" });
logger.info({ port: config.port }, "api_started");

const tools = config.investigationTools;
await internalApp.listen({ port: tools.port, host: tools.host });
logger.info({ host: tools.host, port: tools.port }, "investigation_tools_started");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => void close().then(() => process.exit(0)));
}
