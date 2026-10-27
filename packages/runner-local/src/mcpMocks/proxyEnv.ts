/** Preserve caller proxy bypasses and keep owned loopback MCP traffic local. */
export function mcpProxyEnv(env: {NO_PROXY?: string; no_proxy?: string}): {
  NO_PROXY: string;
  no_proxy: string;
} {
  const bypass = [
    ...new Set(
      [env.NO_PROXY ?? '', env.no_proxy ?? '', '127.0.0.1,localhost,::1']
        .flatMap((value) => value.split(','))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].join(',');
  return {NO_PROXY: bypass, no_proxy: bypass};
}
