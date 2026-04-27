import { ApnsClient, Notification } from 'apns2';
import fs from 'fs';

export type PushProvider = 'unifiedpush' | 'webhook' | 'fcm' | 'apns' | 'webpush';

export interface PushPayload
{
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface PushSendResult
{
  ok: boolean;
  target: string;
  statusCode?: number;
  responseBody?: string;
  error?: string;
}

export interface UnifiedPushConfig
{
  endpoints?: string[];
  base_url?: string;
  topic?: string;
  auth_token?: string;
}

export interface WebhookPushConfig
{
  url: string;
  method?: 'POST' | 'PUT' | 'PATCH';
  auth_token?: string;
  headers?: Record<string, string>;
}

export interface ApnsConfig
{
  key?: string;
  key_id?: string;
  team_id?: string;
  app_id?: string;
  production?: boolean;
  device_tokens?: string[];
}

function parseJsonObject (value: string): Record<string, unknown>
{
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function getStringArray (value: unknown): string[]
{
  if (!Array.isArray(value)) return [];
  return value
    .map(v => typeof v === 'string' ? v.trim() : '')
    .filter(Boolean);
}

function truncateBody (raw: string, max = 1000): string
{
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}...`;
}

async function postJson (
  target: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<PushSendResult>
{
  try {
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const responseBody = truncateBody(await response.text());
    return {
      ok: response.ok,
      target,
      statusCode: response.status,
      responseBody,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      target,
      error: err instanceof Error ? err.message : 'Unknown network error',
    };
  }
}

async function sendUnifiedPush (
  rawConfig: Record<string, unknown>,
  payload: PushPayload
): Promise<PushSendResult[]>
{
  const config = rawConfig as UnifiedPushConfig;
  const endpoints = getStringArray(config.endpoints);
  const headers: Record<string, string> = {};
  if (typeof config.auth_token === 'string' && config.auth_token.trim()) {
    headers.authorization = `Bearer ${config.auth_token.trim()}`;
  }

  const messageBody = {
    title: payload.title,
    message: payload.body,
    data: payload.data ?? {},
  };

  if (endpoints.length > 0) {
    return Promise.all(endpoints.map(target => postJson(target, messageBody, headers)));
  }

  const baseUrl = typeof config.base_url === 'string' ? config.base_url.replace(/\/+$/, '') : '';
  const topic = typeof config.topic === 'string' ? config.topic.trim() : '';
  if (!baseUrl || !topic) {
    return [{
      ok: false,
      target: 'unifiedpush',
      error: 'UnifiedPush config requires either endpoints[] or base_url + topic',
    }];
  }

  const topicTarget = `${baseUrl}/${topic}`;
  return [await postJson(topicTarget, messageBody, headers)];
}

async function sendWebhook (
  rawConfig: Record<string, unknown>,
  payload: PushPayload
): Promise<PushSendResult[]>
{
  const url = typeof rawConfig.url === 'string' ? rawConfig.url.trim() : '';
  if (!url) {
    return [{ ok: false, target: 'webhook', error: 'Webhook config requires url' }];
  }

  const methodValue = typeof rawConfig.method === 'string' ? rawConfig.method.toUpperCase() : 'POST';
  const method: WebhookPushConfig['method'] = (methodValue === 'PUT' || methodValue === 'PATCH') ? methodValue : 'POST';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const authToken = typeof rawConfig.auth_token === 'string' ? rawConfig.auth_token.trim() : '';
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`;
  }
  if (rawConfig.headers && typeof rawConfig.headers === 'object' && !Array.isArray(rawConfig.headers)) {
    for (const [key, value] of Object.entries(rawConfig.headers)) {
      if (typeof value === 'string' && key.trim()) {
        headers[key] = value;
      }
    }
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        data: payload.data ?? {},
      }),
    });
    const responseBody = truncateBody(await response.text());
    return [{
      ok: response.ok,
      target: url,
      statusCode: response.status,
      responseBody,
      error: response.ok ? undefined : `HTTP ${response.status}`,
    }];
  } catch (err: unknown) {
    return [{
      ok: false,
      target: url,
      error: err instanceof Error ? err.message : 'Unknown network error',
    }];
  }
}

async function sendApns (
  rawConfig: Record<string, unknown>,
  payload: PushPayload
): Promise<PushSendResult[]>
{
  const config = rawConfig as ApnsConfig;
  const key = typeof config.key === 'string' ? config.key.trim() : '';
  const keyId = typeof config.key_id === 'string' ? config.key_id.trim() : '';
  const teamId = typeof config.team_id === 'string' ? config.team_id.trim() : '';
  const appId = typeof config.app_id === 'string' ? config.app_id.trim() : '';
  const deviceTokens = getStringArray(config.device_tokens);

  if (!key || !keyId || !teamId || !appId) {
    return [{ ok: false, target: 'apns', error: 'APNS config requires key, key_id, team_id, and app_id' }];
  }

  if (deviceTokens.length === 0) {
    return [{ ok: false, target: 'apns', error: 'APNS config requires at least one device_token' }];
  }

  try {
    const client = new ApnsClient({
      team: teamId,
      keyId: keyId,
      signingKey: key,
      defaultTopic: appId,
    });

    const notifications = deviceTokens.map(deviceToken =>
      new Notification(deviceToken, {
        alert: { title: payload.title, body: payload.body },
        ...(payload.data ?? {}),
      })
    );

    const results = await client.sendMany(notifications);

    return results.map((result, index) => {
      if ('error' in result) {
        return {
          ok: false,
          target: deviceTokens[index],
          statusCode: result.error.statusCode,
          error: result.error.reason ?? 'Unknown APNS error',
        };
      }
      return {
        ok: true,
        target: deviceTokens[index],
      };
    });
  } catch (err: unknown) {
    return [{ ok: false, target: 'apns', error: err instanceof Error ? err.message : 'Unknown APNS error' }];
  }
}

function notImplementedResult (provider: PushProvider): PushSendResult[]
{
  return [{
    ok: false,
    target: provider,
    error: `${provider.toUpperCase()} provider adapter is not implemented yet`,
  }];
}

export function parsePushConfig (configJson: string): Record<string, unknown>
{
  return parseJsonObject(configJson);
}

export function supportedPushProviders (): PushProvider[]
{
  return ['unifiedpush', 'webhook', 'fcm', 'apns', 'webpush'];
}

export async function sendPush (
  provider: PushProvider,
  configJson: string,
  payload: PushPayload
): Promise<PushSendResult[]>
{
  const parsedConfig = parsePushConfig(configJson);
  switch (provider) {
    case 'unifiedpush':
      return sendUnifiedPush(parsedConfig, payload);
    case 'webhook':
      return sendWebhook(parsedConfig, payload);
    case 'apns':
      return sendApns(parsedConfig, payload);
    case 'fcm':
    case 'webpush':
      return notImplementedResult(provider);
    default:
      return [{
        ok: false,
        target: provider,
        error: `Unsupported push provider: ${provider}`,
      }];
  }
}
