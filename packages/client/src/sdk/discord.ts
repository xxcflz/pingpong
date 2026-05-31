import {
  DiscordSDK,
  DiscordSDKMock,
  type IDiscordSDK,
  patchUrlMappings,
} from '@discord/embedded-app-sdk';
import { DISCORD_CLIENT_ID, SERVER_HOST } from '../env';

const DISCORD_PROXY_PREFIXES = ['/api', '/ws', '/spectate'] as const;

export class DiscordContext {
  /** Internal flag — true once patchUrlMappings has run. */
  private _patched = false;

  /** The underlying SDK instance (real or mock). */
  readonly sdk: IDiscordSDK;

  /** Whether this context uses the mock SDK. */
  readonly isMock: boolean;

  private _accessToken: string | null = null;
  private _userId: string | null = null;

  get accessToken(): string | null {
    return this._accessToken;
  }

  get userId(): string | null {
    return this._userId;
  }

  private constructor(sdk: IDiscordSDK, isMock: boolean) {
    this.sdk = sdk;
    this.isMock = isMock;
  }

  // ──────────────────────────── Initialiser ────────────────────────────
  /**
   * Create and fully initialise a DiscordContext.
   *
   * Ordering enforced:
   *   1. new DiscordSDK(clientId)
   *   2. await sdk.ready()
   *   3. patchUrlMappings([...])   ← MUST happen before any network call
   */
  static async init(clientId?: string, serverHost = SERVER_HOST): Promise<DiscordContext> {
    const id = clientId ?? DISCORD_CLIENT_ID;
    const isMock = isMockMode();

    const sdk: IDiscordSDK = isMock ? new DiscordSDKMock(id, null, null, null) : new DiscordSDK(id);

    // Step 2 — wait until Discord signals READY (with timeout fallback)
    try {
      await Promise.race([
        sdk.ready(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('sdk.ready() timeout after 5s')), 5000),
        ),
      ]);
    } catch (err) {}

    const ctx = new DiscordContext(sdk, isMock);

    // Step 3 — patch fetch / WS / XHR through Discord's proxy.
    // The SDK expects concrete target hosts/paths, not Developer Portal labels.
    if (!isMock) {
      patchUrlMappings(createUrlMappings(serverHost));
    } else {
    }
    ctx._patched = true;

    return ctx;
  }

  // ──────────────────────────── Guard ──────────────────────────────────
  /** Assert that patchUrlMappings has already been called. */
  assertReady(): void {
    if (!this._patched) {
      throw new Error('[DiscordContext] Cannot perform network calls before init() completes.');
    }
  }

  // ──────────────────────────── Authorize flow ─────────────────────────
  /**
   * Run the full OAuth2 authorize → token exchange → authenticate flow.
   * Call this AFTER init() returns.
   */
  async authorize(serverHost: string): Promise<void> {
    // This is a convenience — callers can also use sdk.commands directly.
    const { code } = await this.sdk.commands.authorize({
      client_id: this.sdk.clientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: ['identify'],
    });

    const tokenBody = JSON.stringify({ code });
    const tokenUrls = this.isMock
      ? [`${normalizeServerHost(serverHost)}/api/token`]
      : ['/api/api/token', '/api/token'];

    let res: Response | null = null;
    let responseText = '';
    for (const fetchUrl of tokenUrls) {
      res = await fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: tokenBody,
      });
      responseText = await res.text();
      if (res.ok || res.status !== 404) {
        break;
      }
    }

    if (!res) {
      throw new Error('Token exchange failed before request was sent');
    }

    if (!res.ok) {
      throw new Error(`Token exchange failed with status ${res.status}: ${responseText}`);
    }

    if (!responseText.trim()) {
      throw new Error('Server returned empty response');
    }

    // Now try to parse as JSON
    let data: unknown;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(`Server returned invalid JSON: ${responseText.substring(0, 100)}`);
    }

    const { access_token } = data as { access_token: string };
    this._accessToken = access_token;

    const auth = await this.sdk.commands.authenticate({ access_token });
    this._userId = auth.user.id;
  }
}

// ──────────────────────────── Helpers ──────────────────────────────────

/** Detect mock mode — enabled by `?frame_id=mock` OR when `frame_id` is missing (auto-mock). */
function isMockMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has('frame_id')) {
    return params.get('frame_id') === 'mock';
  }
  return true;
}

function createUrlMappings(serverHost: string): Array<{ prefix: string; target: string }> {
  const base = toUrl(serverHost);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');

  return DISCORD_PROXY_PREFIXES.map((prefix) => ({
    prefix,
    target: `${base.host}${basePath}${prefix}`,
  }));
}

function normalizeServerHost(serverHost: string): string {
  const url = toUrl(serverHost);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

function toUrl(host: string): URL {
  return new URL(host.includes('://') ? host : `http://${host}`);
}
