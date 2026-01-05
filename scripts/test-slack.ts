import { WebClient } from '@slack/web-api';
import * as dotenv from 'dotenv';

dotenv.config();

async function testSlack() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;

  console.log('Bot Token:', botToken ? botToken.substring(0, 20) + '...' : 'NOT SET');
  console.log('Channel ID:', channelId || 'NOT SET');

  if (!botToken || !channelId) {
    console.log('Missing config');
    return;
  }

  const client = new WebClient(botToken);

  try {
    // Test auth
    const authResult = await client.auth.test();
    console.log('Auth test passed:', authResult.ok);
    console.log('Bot user:', authResult.user);
    console.log('Team:', authResult.team);

    // Try to send a test message
    const msgResult = await client.chat.postMessage({
      channel: channelId,
      text: 'Test alert from ANCF',
    });
    console.log('Message sent:', msgResult.ok);
    console.log('Message ts:', msgResult.ts);
  } catch (error: unknown) {
    const err = error as { message?: string; code?: string; data?: unknown };
    console.error('Slack error:', err.message);
    console.error('Error code:', err.code);
    console.error('Error data:', err.data);
  }
}

testSlack();
