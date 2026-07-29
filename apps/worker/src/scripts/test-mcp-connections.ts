import { loadEnv } from "../config.js";
import { connectHuddleBot, listGroups } from "../mcp/huddleBot.js";
import { connectResaSquash, listAvailability, listGroupMembers, listMyGroups } from "../mcp/resaSquash.js";

async function main(): Promise<void> {
  const env = loadEnv();

  console.log("[test-mcp] Connexion à huddle-bot...");
  const huddleBot = await connectHuddleBot(env.huddleBotMcpUrl, env.huddleBotMcpApiKey);
  try {
    const { groups } = await listGroups(huddleBot.client);
    console.log(`[test-mcp] huddle-bot list_groups → ${groups.length} groupe(s)`);
    console.log(groups);
  } finally {
    await huddleBot.close();
  }

  console.log("[test-mcp] Connexion à resa-squash...");
  const resaSquash = await connectResaSquash(env.resaSquashMcpUrl, env.resaSquashMcpApiKey);
  try {
    const { groups } = await listMyGroups(resaSquash.client);
    console.log(`[test-mcp] resa-squash list_my_groups → ${groups.length} groupe(s)`);
    console.log(groups);

    if (groups.length > 0) {
      const { members } = await listGroupMembers(resaSquash.client, groups[0].groupId);
      console.log(`[test-mcp] resa-squash list_group_members → ${members.length} membre(s)`);

      const onDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { availability } = await listAvailability(resaSquash.client, onDate, onDate);
      console.log(`[test-mcp] resa-squash list_availability pour ${onDate} :`);
      console.log(availability);
    }
  } finally {
    await resaSquash.close();
  }
}

main().catch((err) => {
  console.error("[test-mcp] erreur :", err);
  process.exit(1);
});
