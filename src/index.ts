import { loadConfig } from "./config.js";
import { createMinecraftBot } from "./minecraft.js";
import { runTask } from "./runner.js";

const config = loadConfig();
const bot = await createMinecraftBot(config);

try {
  const result = await runTask(bot, config);
  console.log(JSON.stringify(result, null, 2));
} finally {
  bot.quit();
}
