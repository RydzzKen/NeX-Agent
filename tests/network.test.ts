import { describe, expect, it } from "vitest";
import { isPrivateHost } from "../src/util/network.js";

describe("isPrivateHost", () => {
  it("mengenali IPv4 privat, loopback, dan link-local", () => {
    expect(isPrivateHost("http://192.168.137.38:20128/v1")).toBe(true);
    expect(isPrivateHost("http://10.0.0.5/v1")).toBe(true);
    expect(isPrivateHost("http://172.16.0.1:1234")).toBe(true);
    expect(isPrivateHost("http://172.31.255.255")).toBe(true);
    expect(isPrivateHost("http://127.0.0.1:8080")).toBe(true);
    expect(isPrivateHost("http://169.254.1.1")).toBe(true);
  });

  it("mengenali localhost dan domain .local", () => {
    expect(isPrivateHost("localhost:20128")).toBe(true);
    expect(isPrivateHost("http://foo.local/v1")).toBe(true);
    expect(isPrivateHost("http://[::1]:8080/v1")).toBe(true);
  });

  it("menerima host mentah maupun URL lengkap", () => {
    expect(isPrivateHost("192.168.0.2")).toBe(true);
    expect(isPrivateHost("10.1.2.3:5000")).toBe(true);
  });

  it("menganggap alamat publik sebagai bukan privat", () => {
    expect(isPrivateHost("https://api.openai.com/v1")).toBe(false);
    expect(isPrivateHost("https://api.anthropic.com")).toBe(false);
    expect(isPrivateHost("http://8.8.8.8")).toBe(false);
    // 172.32 di luar rentang privat 172.16/12.
    expect(isPrivateHost("http://172.32.0.1")).toBe(false);
  });

  it("aman untuk nilai kosong/tak valid", () => {
    expect(isPrivateHost(undefined)).toBe(false);
    expect(isPrivateHost("")).toBe(false);
    expect(isPrivateHost("   ")).toBe(false);
    expect(isPrivateHost("http://")).toBe(false);
  });
});
