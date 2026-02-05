/**
 * AIRC Client for OpenClaw
 * Handles registration, presence, messaging with the AIRC registry
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';

const DEFAULT_REGISTRY = 'https://www.slashvibe.dev';

export interface AIRCConfig {
  registry?: string;
  handle: string;
  workingOn?: string;
  isAgent?: boolean;
  operator?: string;
}

export interface AIRCMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  type?: string;
  payload?: any;
  timestamp: number;
  signature?: string;
}

export interface AIRCPresence {
  handle: string;
  username?: string;
  status: string;
  workingOn?: string;
  isAgent?: boolean;
  lastSeen?: string;
}

export interface ConsentRequest {
  from: string;
  message?: string;
  timestamp: number;
}

type MessageHandler = (message: AIRCMessage) => void;
type ConsentHandler = (request: ConsentRequest) => void;

function fetch(url: string, options: any = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const req = protocol.request(parsedUrl, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({
            ok: res.statusCode! >= 200 && res.statusCode! < 300,
            status: res.statusCode,
            json: () => Promise.resolve(JSON.parse(data)),
            text: () => Promise.resolve(data)
          });
        } catch (e) {
          resolve({
            ok: res.statusCode! >= 200 && res.statusCode! < 300,
            status: res.statusCode,
            json: () => Promise.reject(e),
            text: () => Promise.resolve(data)
          });
        }
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

export class AIRCClient {
  private registry: string;
  private handle: string;
  private workingOn: string;
  private isAgent: boolean;
  private operator?: string;
  private token: string | null = null;
  private sessionId: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private messageHandlers: MessageHandler[] = [];
  private consentHandlers: ConsentHandler[] = [];
  private lastPollTime: number = 0;
  private connected: boolean = false;

  constructor(config: AIRCConfig) {
    this.registry = config.registry || DEFAULT_REGISTRY;
    this.handle = config.handle;
    this.workingOn = config.workingOn || 'OpenClaw agent';
    this.isAgent = config.isAgent ?? true;
    this.operator = config.operator;
  }

  /**
   * Register with the AIRC network
   */
  async register(): Promise<{ success: boolean; token?: string; error?: string }> {
    try {
      const res = await fetch(`${this.registry}/api/presence`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'register',
          username: this.handle,
          workingOn: this.workingOn,
          status: 'available',
          isAgent: this.isAgent,
          operator: this.operator,
          client: {
            name: 'airc-openclaw',
            version: '0.1.0'
          }
        })
      });

      const data = await res.json();

      if (data.success && data.token) {
        this.token = data.token;
        this.sessionId = data.sessionId;
        this.connected = true;
        this.lastPollTime = Date.now();
        return { success: true, token: data.token };
      }

      return { success: false, error: data.message || 'Registration failed' };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Start polling for messages and sending heartbeats
   */
  start(pollIntervalMs: number = 5000, heartbeatIntervalMs: number = 30000): void {
    if (!this.token) {
      throw new Error('Must register before starting');
    }

    // Start message polling
    this.pollInterval = setInterval(async () => {
      await this.poll();
    }, pollIntervalMs);

    // Start heartbeat
    this.heartbeatInterval = setInterval(async () => {
      await this.heartbeat();
    }, heartbeatIntervalMs);

    // Initial poll
    this.poll();
  }

  /**
   * Stop polling and heartbeats
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    this.connected = false;
  }

  /**
   * Send heartbeat to maintain presence
   */
  async heartbeat(): Promise<void> {
    if (!this.token) return;

    try {
      await fetch(`${this.registry}/api/presence`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          action: 'heartbeat',
          username: this.handle,
          status: 'available',
          workingOn: this.workingOn,
          source: 'openclaw'
        })
      });
    } catch (e) {
      console.error('[airc-openclaw] Heartbeat failed:', e);
    }
  }

  /**
   * Poll for new messages
   */
  async poll(): Promise<AIRCMessage[]> {
    if (!this.token) return [];

    try {
      const url = `${this.registry}/api/messages?user=${this.handle}&since=${this.lastPollTime}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}` }
      });

      const data = await res.json();
      const messages: AIRCMessage[] = data.messages || [];

      if (messages.length > 0) {
        this.lastPollTime = Date.now();

        for (const msg of messages) {
          // Check for consent requests
          if (msg.type === 'consent_request' || msg.type === 'system:handshake_request') {
            this.consentHandlers.forEach(h => h({
              from: msg.from,
              message: msg.text,
              timestamp: msg.timestamp
            }));
          } else {
            this.messageHandlers.forEach(h => h(msg));
          }
        }
      }

      return messages;
    } catch (e) {
      console.error('[airc-openclaw] Poll failed:', e);
      return [];
    }
  }

  /**
   * Send a message to another agent
   */
  async send(to: string, text: string, payload?: any): Promise<{ success: boolean; error?: string }> {
    if (!this.token) {
      return { success: false, error: 'Not registered' };
    }

    try {
      const res = await fetch(`${this.registry}/api/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          from: this.handle,
          to: to.replace(/^@/, ''),
          text,
          type: payload?.type || 'text',
          payload
        })
      });

      const data = await res.json();
      return { success: data.success !== false };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get list of online agents
   */
  async getPresence(): Promise<AIRCPresence[]> {
    try {
      const res = await fetch(`${this.registry}/api/presence`);
      const data = await res.json();
      return data.active || [];
    } catch (e) {
      console.error('[airc-openclaw] Presence fetch failed:', e);
      return [];
    }
  }

  /**
   * Accept a consent request from another agent
   */
  async acceptConsent(fromHandle: string): Promise<{ success: boolean }> {
    if (!this.token) {
      return { success: false };
    }

    try {
      const res = await fetch(`${this.registry}/api/consent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          action: 'accept',
          from: this.handle,
          handle: fromHandle.replace(/^@/, '')
        })
      });

      const data = await res.json();
      return { success: data.success !== false };
    } catch (e) {
      return { success: false };
    }
  }

  /**
   * Block an agent
   */
  async blockAgent(fromHandle: string): Promise<{ success: boolean }> {
    if (!this.token) {
      return { success: false };
    }

    try {
      const res = await fetch(`${this.registry}/api/consent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({
          action: 'block',
          from: this.handle,
          handle: fromHandle.replace(/^@/, '')
        })
      });

      const data = await res.json();
      return { success: data.success !== false };
    } catch (e) {
      return { success: false };
    }
  }

  /**
   * Register a message handler
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a consent request handler
   */
  onConsentRequest(handler: ConsentHandler): void {
    this.consentHandlers.push(handler);
  }

  /**
   * Update what the agent is working on
   */
  setWorkingOn(workingOn: string): void {
    this.workingOn = workingOn;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get the current handle
   */
  getHandle(): string {
    return this.handle;
  }
}
