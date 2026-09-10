import { CronCapability, handler, Runner } from "@chainlink/cre-sdk";
import { type Config, configSchema } from "./src/config";
import { onCron } from "./src/workflow";

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
];

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
