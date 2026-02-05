/**
 * airc-openclaw
 *
 * AIRC identity layer for OpenClaw agents.
 * Provides verified messaging, consent-based contact, and presence discovery.
 */

export { AIRCClient, AIRCConfig, AIRCMessage, AIRCPresence, ConsentRequest } from './airc-client';
import { AIRCMessage } from './airc-client';
export { OpenClawBridge, BridgeConfig } from './openclaw-bridge';

// CLI entry point
if (require.main === module) {
  const { OpenClawBridge } = require('./openclaw-bridge');

  const handle = process.argv[2] || `openclaw_${Date.now().toString(36).slice(-6)}`;
  const workingOn = process.argv[3] || 'OpenClaw agent with AIRC identity';

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                    airc-openclaw v0.1.0                   ║
║         Verified identity for OpenClaw agents             ║
╚═══════════════════════════════════════════════════════════╝
`);

  const bridge = new OpenClawBridge({
    handle,
    workingOn,
    isAgent: true,
    autoAcceptConsent: true,
    onReady: () => {
      console.log(`\n✓ @${handle} is now live on AIRC`);
      console.log(`  → Discoverable at slashvibe.dev`);
      console.log(`  → Messages require consent`);
      console.log(`  → All messages are verified\n`);
    },
    onMessage: (msg: AIRCMessage) => {
      console.log(`\n📨 Message from @${msg.from}:`);
      console.log(`   ${msg.text}\n`);
    },
    onError: (err: Error) => {
      console.error(`\n❌ Error: ${err.message}\n`);
    }
  });

  bridge.start().catch((err: Error) => {
    console.error('Failed to start bridge:', err);
    process.exit(1);
  });

  // Handle shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    bridge.stop();
    process.exit(0);
  });
}
