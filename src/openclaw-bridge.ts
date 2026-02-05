/**
 * OpenClaw Gateway Bridge
 * Connects AIRC messaging to OpenClaw's WebSocket gateway
 */

import WebSocket from 'ws';
import { AIRCClient, AIRCMessage, AIRCConfig } from './airc-client';

const OPENCLAW_GATEWAY = 'ws://127.0.0.1:18789';

export interface BridgeConfig extends AIRCConfig {
  gatewayUrl?: string;
  autoAcceptConsent?: boolean;
  onReady?: () => void;
  onMessage?: (msg: AIRCMessage) => void;
  onError?: (error: Error) => void;
}

export class OpenClawBridge {
  private airc: AIRCClient;
  private gateway: WebSocket | null = null;
  private gatewayUrl: string;
  private autoAcceptConsent: boolean;
  private config: BridgeConfig;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.gatewayUrl = config.gatewayUrl || OPENCLAW_GATEWAY;
    this.autoAcceptConsent = config.autoAcceptConsent ?? true;

    this.airc = new AIRCClient({
      registry: config.registry,
      handle: config.handle,
      workingOn: config.workingOn,
      isAgent: config.isAgent ?? true,
      operator: config.operator
    });

    // Set up AIRC message handler
    this.airc.onMessage((msg) => {
      this.handleAIRCMessage(msg);
    });

    // Set up consent handler
    this.airc.onConsentRequest((req) => {
      if (this.autoAcceptConsent) {
        console.log(`[airc-openclaw] Auto-accepting consent from @${req.from}`);
        this.airc.acceptConsent(req.from);
      } else {
        // Forward to OpenClaw gateway for user decision
        this.sendToGateway({
          type: 'airc:consent_request',
          from: req.from,
          message: req.message,
          timestamp: req.timestamp
        });
      }
    });
  }

  /**
   * Start the bridge - connect to both AIRC and OpenClaw gateway
   */
  async start(): Promise<void> {
    // Register with AIRC
    console.log(`[airc-openclaw] Registering @${this.config.handle} with AIRC...`);
    const result = await this.airc.register();

    if (!result.success) {
      const error = new Error(`AIRC registration failed: ${result.error}`);
      this.config.onError?.(error);
      throw error;
    }

    console.log(`[airc-openclaw] Registered! Connecting to OpenClaw gateway...`);

    // Connect to OpenClaw gateway
    await this.connectGateway();

    // Start AIRC polling and heartbeats
    this.airc.start(3000, 30000);

    console.log(`[airc-openclaw] Bridge active. @${this.config.handle} is now on AIRC + OpenClaw.`);
    this.config.onReady?.();
  }

  /**
   * Connect to OpenClaw WebSocket gateway
   */
  private connectGateway(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.gateway = new WebSocket(this.gatewayUrl);

        this.gateway.on('open', () => {
          console.log('[airc-openclaw] Connected to OpenClaw gateway');
          this.reconnectAttempts = 0;

          // Register as AIRC channel
          this.sendToGateway({
            type: 'channel:register',
            channel: 'airc',
            handle: this.config.handle
          });

          resolve();
        });

        this.gateway.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.handleGatewayMessage(msg);
          } catch (e) {
            console.error('[airc-openclaw] Failed to parse gateway message:', e);
          }
        });

        this.gateway.on('close', () => {
          console.log('[airc-openclaw] Gateway connection closed');
          this.attemptReconnect();
        });

        this.gateway.on('error', (err) => {
          console.error('[airc-openclaw] Gateway error:', err);
          this.config.onError?.(err);
        });

      } catch (e: any) {
        reject(e);
      }
    });
  }

  /**
   * Attempt to reconnect to gateway
   */
  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[airc-openclaw] Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

    console.log(`[airc-openclaw] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connectGateway().catch(e => {
        console.error('[airc-openclaw] Reconnect failed:', e);
      });
    }, delay);
  }

  /**
   * Handle message from AIRC network
   */
  private handleAIRCMessage(msg: AIRCMessage): void {
    console.log(`[airc-openclaw] Message from @${msg.from}: ${msg.text?.slice(0, 50)}...`);

    // Invoke callback if provided
    this.config.onMessage?.(msg);

    // Forward to OpenClaw gateway
    this.sendToGateway({
      type: 'airc:message',
      from: msg.from,
      text: msg.text,
      payload: msg.payload,
      timestamp: msg.timestamp,
      messageId: msg.id
    });
  }

  /**
   * Handle message from OpenClaw gateway
   */
  private handleGatewayMessage(msg: any): void {
    switch (msg.type) {
      case 'airc:send':
        // OpenClaw wants to send via AIRC
        this.airc.send(msg.to, msg.text, msg.payload);
        break;

      case 'airc:accept_consent':
        // User accepted consent request
        this.airc.acceptConsent(msg.handle);
        break;

      case 'airc:block':
        // User blocked an agent
        this.airc.blockAgent(msg.handle);
        break;

      case 'airc:presence':
        // Request presence list
        this.airc.getPresence().then(presence => {
          this.sendToGateway({
            type: 'airc:presence_response',
            agents: presence
          });
        });
        break;

      case 'airc:update_status':
        // Update working on
        this.airc.setWorkingOn(msg.workingOn);
        break;

      default:
        // Unknown message type - ignore
        break;
    }
  }

  /**
   * Send message to OpenClaw gateway
   */
  private sendToGateway(msg: any): void {
    if (this.gateway?.readyState === WebSocket.OPEN) {
      this.gateway.send(JSON.stringify(msg));
    }
  }

  /**
   * Send a message via AIRC
   */
  async send(to: string, text: string, payload?: any): Promise<{ success: boolean; error?: string }> {
    return this.airc.send(to, text, payload);
  }

  /**
   * Get online agents
   */
  async getPresence() {
    return this.airc.getPresence();
  }

  /**
   * Stop the bridge
   */
  stop(): void {
    this.airc.stop();
    if (this.gateway) {
      this.gateway.close();
      this.gateway = null;
    }
  }

  /**
   * Check if bridge is connected
   */
  isConnected(): boolean {
    return this.airc.isConnected() && this.gateway?.readyState === WebSocket.OPEN;
  }
}
