import { describe, expect, it } from "vitest";
import { exportHosts } from "../host-export.js";
import { parseCsv } from "./csv.js";
import { detectFormat, parseHostSource } from "./index.js";
import { hostKey, inferEnvironment, splitAddressPort } from "./normalize.js";

describe("format detection", () => {
  it("recognises each supported source format", () => {
    expect(detectFormat('{"generator":"onshell.cloud","hosts":[]}')).toBe("onshell-json");
    expect(detectFormat('{"hosts":[{"label":"x","address":"1.1.1.1"}]}')).toBe("termius-json");
    expect(detectFormat("[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\web]")).toBe("putty-reg");
    expect(detectFormat("<RDCMan programVersion=\"2.7\"><file></file></RDCMan>")).toBe("rdcman");
    expect(detectFormat("full address:s:10.0.0.9:3389")).toBe("rdp");
    expect(detectFormat("Host web\n  HostName 10.0.0.1\n")).toBe("ssh-config");
    expect(detectFormat("Label,Hostname,Port\nweb,10.0.0.1,22")).toBe("csv");
  });

  it("falls back to the file extension when the content is ambiguous", () => {
    expect(detectFormat("just-a-name\n", "sessions.rdp")).toBe("rdp");
    expect(detectFormat("noheaders\n", "estate.rdg")).toBe("rdcman");
  });

  it("returns undefined for content it cannot place", () => {
    expect(detectFormat("hello world")).toBeUndefined();
  });
});

describe("OpenSSH config import", () => {
  const config = `
# Primary jump box
Host bastion-prod
  HostName 10.20.0.10
  Port 2222
  User deploy
  IdentityFile ~/.ssh/id_ed25519

Host db-staging
  HostName db.stg.internal
  User postgres

Host *.internal
  User fallback

Host shorthand
`;

  it("maps Host blocks, inherits the alias as address, and defaults the port", () => {
    const result = parseHostSource({ text: config });

    expect(result.format).toBe("ssh-config");
    expect(result.hosts).toHaveLength(3);

    const [bastion, db, shorthand] = result.hosts;

    expect(bastion).toMatchObject({
      name: "bastion-prod",
      address: "10.20.0.10",
      port: 2222,
      username: "deploy",
      type: "ssh",
      // "prod" in the name is the only evidence available.
      environment: "production",
      notes: "Primary jump box"
    });

    // No Port directive → protocol default.
    expect(db).toMatchObject({ address: "db.stg.internal", port: 22, environment: "staging" });

    // No HostName → the alias is the address.
    expect(shorthand).toMatchObject({ name: "shorthand", address: "shorthand", port: 22 });
  });

  it("skips wildcard blocks and explains why", () => {
    const result = parseHostSource({ text: config });
    expect(result.issues.some((issue) => issue.message.includes("wildcard"))).toBe(true);
  });
});

describe("Termius import", () => {
  it("reads the CSV export with fuzzy header names", () => {
    const csv = [
      "Label,Tags,Hostname,Port,Username,Group",
      "Prod Web,\"linux,web\",10.0.0.1,22,deploy,Core",
      "Finance RDP,windows,10.0.4.12,3389,ops-admin,Operations"
    ].join("\n");

    const result = parseHostSource({ text: csv });

    expect(result.format).toBe("csv");
    expect(result.hosts[0]).toMatchObject({
      name: "Prod Web",
      address: "10.0.0.1",
      port: 22,
      username: "deploy",
      group: "Core",
      tags: ["linux", "web"]
    });
    // Port 3389 with no explicit type still resolves to RDP.
    expect(result.hosts[1]).toMatchObject({ type: "rdp", port: 3389 });
  });

  it("reads the JSON export, including nested group and identity objects", () => {
    const json = JSON.stringify({
      hosts: [
        {
          label: "Edge 01",
          address: "edge01.example.com",
          port: 2200,
          group: { label: "Edge" },
          tags: [{ label: "linux" }],
          identity: { username: "core" }
        }
      ]
    });

    const result = parseHostSource({ text: json });

    expect(result.format).toBe("termius-json");
    expect(result.hosts[0]).toMatchObject({
      name: "Edge 01",
      address: "edge01.example.com",
      port: 2200,
      username: "core",
      group: "Edge",
      tags: ["linux"]
    });
  });
});

describe("PuTTY registry import", () => {
  it("decodes session names, hex ports, and skips serial sessions", () => {
    const reg = `Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\My%20Prod%20Box]
"HostName"="10.9.9.9"
"PortNumber"=dword:000008ae
"UserName"="root"
"Protocol"="ssh"

[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Console]
"Protocol"="serial"
"SerialLine"="COM1"
`;

    const result = parseHostSource({ text: reg });

    expect(result.format).toBe("putty-reg");
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
      name: "My Prod Box",
      address: "10.9.9.9",
      // 0x8ae === 2222
      port: 2222,
      username: "root",
      type: "ssh"
    });
    expect(result.issues.some((issue) => issue.message.includes("serial"))).toBe(true);
  });
});

describe("Windows RDP import", () => {
  it("reads a .rdp file, splits the port, and strips the domain from the username", () => {
    const rdp = [
      "screen mode id:i:2",
      "full address:s:10.0.4.20:3390",
      "username:s:CORP\\alice",
      "domain:s:CORP",
      "audiomode:i:0"
    ].join("\r\n");

    const result = parseHostSource({ text: rdp, filename: "Finance Server.rdp" });

    expect(result.format).toBe("rdp");
    expect(result.hosts[0]).toMatchObject({
      // Filename becomes the label, since .rdp carries no name field.
      name: "Finance Server",
      address: "10.0.4.20",
      port: 3390,
      username: "alice",
      type: "rdp",
      notes: "RDP domain: CORP"
    });
  });

  it("defaults to 3389 and handles several concatenated .rdp files", () => {
    const rdp = ["full address:s:10.0.0.1", "username:s:admin", "full address:s:10.0.0.2"].join("\n");

    const result = parseHostSource({ text: rdp, format: "rdp" });

    expect(result.hosts).toHaveLength(2);
    expect(result.hosts[0]).toMatchObject({ address: "10.0.0.1", port: 3389 });
    expect(result.hosts[1]).toMatchObject({ address: "10.0.0.2", port: 3389 });
  });
});

describe("RDCMan import", () => {
  it("reads nested groups and prefers displayName as the label", () => {
    const rdg = `<?xml version="1.0" encoding="utf-8"?>
<RDCMan programVersion="2.7" schemaVersion="3">
  <file>
    <properties><name>Estate</name></properties>
    <group>
      <properties><name>Datacenter A</name></properties>
      <server>
        <properties>
          <name>dca-web01.corp.local</name>
          <displayName>DCA Web 01</displayName>
        </properties>
      </server>
      <server>
        <properties><name>dca-db01.corp.local</name></properties>
      </server>
    </group>
  </file>
</RDCMan>`;

    const result = parseHostSource({ text: rdg });

    expect(result.format).toBe("rdcman");
    expect(result.hosts).toHaveLength(2);
    expect(result.hosts[0]).toMatchObject({
      name: "DCA Web 01",
      address: "dca-web01.corp.local",
      type: "rdp",
      port: 3389,
      group: "Datacenter A"
    });
    // No displayName → the address doubles as the label.
    expect(result.hosts[1]).toMatchObject({ name: "dca-db01.corp.local", group: "Datacenter A" });
  });
});

describe("CSV reader", () => {
  it("honours quoting, embedded separators, and doubled quotes", () => {
    const rows = parseCsv('a,"b,c","say ""hi"""\n1,2,3\n');
    expect(rows).toEqual([
      ["a", "b,c", 'say "hi"'],
      ["1", "2", "3"]
    ]);
  });

  it("drops blank lines and a UTF-8 BOM", () => {
    const rows = parseCsv("﻿name,address\n\nweb,10.0.0.1\n");
    expect(rows).toEqual([
      ["name", "address"],
      ["web", "10.0.0.1"]
    ]);
  });
});

describe("normalisation", () => {
  it("splits a trailing port but leaves IPv6 literals intact", () => {
    expect(splitAddressPort("10.0.0.1:2222")).toEqual({ address: "10.0.0.1", port: 2222 });
    expect(splitAddressPort("[2001:db8::1]:22")).toEqual({ address: "[2001:db8::1]", port: 22 });
    expect(splitAddressPort("2001:db8::1")).toEqual({ address: "2001:db8::1" });
    expect(splitAddressPort("host.example.com")).toEqual({ address: "host.example.com" });
  });

  it("rejects addresses that would break a connection", () => {
    const result = parseHostSource({ text: "name,address\nbad,http://x.com/path\n" });
    expect(result.hosts).toHaveLength(0);
    expect(result.issues[0].message).toContain("not a usable hostname");
  });

  it("infers the environment from naming rather than guessing production", () => {
    expect(inferEnvironment("web-prod-01")).toBe("production");
    expect(inferEnvironment("api", "staging")).toBe("staging");
    expect(inferEnvironment("random-box")).toBe("development");
  });

  it("treats address+port+username as the identity of a host", () => {
    expect(hostKey({ address: "10.0.0.1", port: 22, username: "Deploy" })).toBe(
      hostKey({ address: "10.0.0.1", port: 22, username: "deploy" })
    );
    expect(hostKey({ address: "10.0.0.1", port: 22 })).not.toBe(hostKey({ address: "10.0.0.1", port: 2222 }));
  });
});

describe("export", () => {
  const hosts = [
    {
      id: "h1",
      organizationId: "org",
      name: "Prod Bastion",
      type: "ssh" as const,
      address: "10.20.0.10",
      port: 2222,
      username: "deploy",
      environment: "production" as const,
      tags: ["linux", "bastion"],
      group: "Core",
      notes: "Jump host",
      health: "online" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    },
    {
      id: "h2",
      organizationId: "org",
      name: "=cmd|calc",
      type: "rdp" as const,
      address: "10.20.4.12",
      port: 3389,
      environment: "production" as const,
      tags: [],
      health: "unknown" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  ];

  it("round-trips through JSON back into the importer", () => {
    const { body } = exportHosts(hosts, "json");
    expect(detectFormat(body)).toBe("onshell-json");

    const reimported = parseHostSource({ text: body });
    expect(reimported.hosts).toHaveLength(2);
    expect(reimported.hosts[0]).toMatchObject({
      name: "Prod Bastion",
      address: "10.20.0.10",
      port: 2222,
      username: "deploy",
      environment: "production",
      group: "Core",
      tags: ["linux", "bastion"]
    });
  });

  it("neutralises spreadsheet formula injection in CSV output", () => {
    const { body } = exportHosts(hosts, "csv");
    // A cell starting with = would execute when opened in Excel or Sheets.
    expect(body).toContain("'=cmd|calc");
    expect(body).not.toMatch(/(^|,)=cmd/m);
  });

  it("never writes credentials into any export format", () => {
    for (const format of ["json", "csv", "ssh-config"] as const) {
      const { body } = exportHosts(hosts, format);
      expect(body.toLowerCase()).not.toContain("password");
      expect(body.toLowerCase()).not.toContain("privatekey");
    }
  });

  it("lists non-SSH hosts as comments in ssh-config output", () => {
    const { body } = exportHosts(hosts, "ssh-config");
    expect(body).toContain("Host Prod-Bastion");
    expect(body).toContain("  HostName 10.20.0.10");
    expect(body).toContain("  Port 2222");
    expect(body).toContain("non-SSH host(s) omitted");
  });
});
