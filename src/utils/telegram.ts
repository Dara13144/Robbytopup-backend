import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GROUP_CHAT_ID = process.env.TELEGRAM_GROUP_CHAT_ID;
const SANDBOX_MODE = process.env.SANDBOX_MODE === 'true';

export async function sendTelegramNotification(message: string): Promise<boolean> {
  const logPrefix = '[Telegram Bot Notification]';
  
  const targetChatIds: string[] = [];
  if (CHAT_ID && !CHAT_ID.includes('MOCK')) {
    targetChatIds.push(CHAT_ID);
  }
  if (GROUP_CHAT_ID && !GROUP_CHAT_ID.includes('MOCK')) {
    targetChatIds.push(GROUP_CHAT_ID);
  }

  if (SANDBOX_MODE || !BOT_TOKEN || BOT_TOKEN.includes('MOCK') || targetChatIds.length === 0) {
    console.log(`\n🔔 ${logPrefix} (SANDBOX MODE - MOCK SEND)`);
    console.log(`-------------------------------------------`);
    console.log(message);
    console.log(`-------------------------------------------\n`);
    return true;
  }

  let allSuccess = true;
  for (const cid of targetChatIds) {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: cid,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`${logPrefix} Failed to send telegram notification to ${cid}:`, errorText);
        allSuccess = false;
      }
    } catch (error) {
      console.error(`${logPrefix} Error sending telegram notification to ${cid}:`, error);
      allSuccess = false;
    }
  }

  return allSuccess;
}

export interface TelegramOrderPayload {
  productSlug?: string;
  gameName?: string;
  packageName?: string;
  packageAmount?: number;
  playerId: string;
  playerZoneId?: string | null;
}

/**
 * Formats the Telegram message to send on a single line separated by space:
 * - For MLBB: "87654321 1234 11 Diamonds" (Player ID, Server ID, Package/Diamond)
 * - For other games: "87654321 11 Diamonds" (Player ID, Package/Diamond)
 */
export function formatTelegramBotOrderMessage(order: TelegramOrderPayload): string {
  const isMLBB =
    (order.productSlug || '').toLowerCase().includes('mobile-legends') ||
    (order.gameName || '').toLowerCase().includes('mobile legends') ||
    !!order.playerZoneId;

  const diamond = order.packageName || (order.packageAmount ? `${order.packageAmount} Diamonds` : 'Diamonds');

  if (isMLBB) {
    const parts = [
      order.playerId,
      order.playerZoneId || '',
      diamond,
    ].filter(Boolean);
    return `<code>${parts.join(' ')}</code>`;
  }

  const parts = [
    order.playerId,
    diamond,
  ].filter(Boolean);
  return `<code>${parts.join(' ')}</code>`;
}
