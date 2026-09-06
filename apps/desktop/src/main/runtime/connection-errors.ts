/** Classify transport errors without exposing credentials or raw SSH diagnostics. */
export function connectionFailure(error: unknown, endpoint: string): string {
  const failure = error as { code?: string; level?: string; cause?: { code?: string } } | null;
  const code = failure?.code ?? failure?.cause?.code;
  if (failure?.level === "client-authentication") return "The host rejected your credentials. Check the SSH username, password or private key.";
  if (failure?.level === "client-timeout" || code === "ETIMEDOUT") return `${endpoint} did not answer in time. Check your VPN, firewall and network connection.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Could not resolve ${endpoint}. Check the hostname and DNS settings.`;
  if (code === "ECONNREFUSED") return `${endpoint} refused the connection. Check that the service is running and the port is correct.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return `There is no network route to ${endpoint}. Connect to the required VPN or check your network.`;
  if (code === "ECONNRESET" || code === "EPIPE") return `${endpoint} closed the connection unexpectedly. Check the service and any firewall or proxy.`;
  if (failure?.level === "handshake") return `The SSH handshake with ${endpoint} failed. Check the server's supported SSH algorithms and configuration.`;
  return `Could not establish a connection to ${endpoint}. Check the address, port and network access.`;
}
