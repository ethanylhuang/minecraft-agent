import { createBot, type Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import type { AppConfig } from "./config.js";

const { Movements, pathfinder } = pathfinderPkg;
const BOT_SPAWN_TIMEOUT_MS = 60_000;

export async function createMinecraftBot(config: AppConfig): Promise<Bot> {
  const bot = createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    version: config.version,
  });

  bot.loadPlugin(pathfinder);

  await waitForSpawn(bot);
  const movements = new Movements(bot);
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  bot.pathfinder.setMovements(movements);
  await bot.waitForTicks(20);
  return bot;
}

function waitForSpawn(bot: Bot): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => cleanup(resolve);
    const onError = (error: Error) => cleanup(() => reject(error));
    const onKicked = (reason: string) => cleanup(() => reject(new Error(`Kicked: ${reason}`)));
    const timeout = setTimeout(() => {
      cleanup(() => reject(new Error(`Bot spawn exceeded ${BOT_SPAWN_TIMEOUT_MS}ms.`)));
    }, BOT_SPAWN_TIMEOUT_MS);
    const cleanup = (done: () => void) => {
      clearTimeout(timeout);
      bot.removeListener("spawn", onSpawn);
      bot.removeListener("error", onError);
      bot.removeListener("kicked", onKicked);
      done();
    };

    bot.once("spawn", onSpawn);
    bot.once("error", onError);
    bot.once("kicked", onKicked);
  });
}
