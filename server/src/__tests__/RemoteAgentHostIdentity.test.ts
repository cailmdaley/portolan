import { describe, expect, it } from 'vitest';

import {
  baseRemoteSshHost,
  normalizedRemoteOriginIdForSshHost,
  normalizedRemoteOriginName,
  qualifyLoginNodeSshHost,
} from '../RemoteAgentHostIdentity.js';

describe('RemoteAgentHostIdentity', () => {
  it('normalizes login-node SSH aliases to the stable remote origin', () => {
    expect(baseRemoteSshHost('cineca-login05')).toBe('cineca');
    expect(normalizedRemoteOriginIdForSshHost('cineca-login05')).toBe('remote-cineca');
    expect(normalizedRemoteOriginName('login05.leonardo.local', 'cineca-login05')).toBe('cineca');
  });

  it('preserves non-login hosts and unqualified origins', () => {
    expect(baseRemoteSshHost('candide')).toBe('candide');
    expect(normalizedRemoteOriginIdForSshHost('candide')).toBe('remote-candide');
    expect(normalizedRemoteOriginName('candide')).toBe('candide');
  });

  it('qualifies base SSH aliases from login-node hostnames', () => {
    expect(qualifyLoginNodeSshHost('login05.leonardo.local', 'cineca')).toBe('cineca-login05');
    expect(qualifyLoginNodeSshHost('login05.leonardo.local', 'cineca-login05')).toBe('cineca-login05');
    expect(qualifyLoginNodeSshHost('candide', 'candide')).toBe('candide');
  });
});
