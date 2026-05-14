const LOGIN_NODE_SUFFIX = /-login\d+$/;
const LOGIN_NODE_HOST = /^(login\d+)(?:\..*)?$/;

export function baseRemoteSshHost(sshHost: string): string {
  return sshHost.replace(LOGIN_NODE_SUFFIX, '');
}

export function normalizedRemoteOriginIdForSshHost(sshHost: string): string {
  return `remote-${baseRemoteSshHost(sshHost)}`;
}

export function normalizedRemoteOriginName(originName: string, sshHost?: string): string {
  return sshHost ? baseRemoteSshHost(sshHost) : originName;
}

export function qualifyLoginNodeSshHost(originName: string, sshHost: string): string {
  const base = sshHost.trim();
  if (!base) return base;

  const loginNode = originName.match(LOGIN_NODE_HOST)?.[1];
  if (!loginNode) return base;
  if (base.endsWith(`-${loginNode}`)) return base;
  return `${baseRemoteSshHost(base)}-${loginNode}`;
}
