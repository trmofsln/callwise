/* eslint-disable @typescript-eslint/no-require-imports -- Node HTTP verification script. */
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");

const base = process.argv[2] || "http://localhost:3101";
const password = randomBytes(24).toString("hex");
const token = `test.${randomBytes(24).toString("hex")}.token`;
let cookie = "";

async function request(endpoint, method = "GET", body, origin) {
  const response = await fetch(`${base}/api/admin/${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

(async () => {
  const initial = await request("session");
  assert.equal(initial.body.configured, false, "Run this script only with a fresh, isolated test database");
  assert.equal((await request("settings")).response.status, 401);
  const setup = await request("session", "POST", { action: "setup", password }, base);
  assert.equal(setup.response.status, 200);
  const setCookie = setup.response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  cookie = setCookie.split(";")[0];
  assert.equal((await request("session", "POST", { action: "setup", password }, base)).response.status, 409);
  assert.equal((await request("session", "POST", { password: "wrong-password" }, base)).response.status, 401);
  const saved = await request("settings", "PUT", { employeeId: "12345", token, notes: "API test", metadata: { region: "north" } }, base);
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.hasToken, true);
  assert.equal(JSON.stringify(saved.body).includes(token), false);
  const edited = await request("settings", "PUT", { employeeId: "67890", token: "", metadata: { region: "south" } }, base);
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.hasToken, true);
  const read = await request("settings");
  assert.equal(read.body.employeeId, "67890");
  assert.equal(read.body.metadata.region, "south");
  assert.equal(JSON.stringify(read.body).includes(token), false);
  assert.equal((await request("settings", "PUT", { employeeId: "0" }, base)).response.status, 400);
  assert.equal((await request("settings", "PUT", { employeeId: "67890" }, "https://unrelated.example")).response.status, 403);
  const cleared = await request("settings", "PUT", { employeeId: "67890", clearToken: true }, base);
  assert.equal(cleared.body.hasToken, false);
  assert.equal((await request("session", "DELETE", undefined, base)).response.status, 200);
  assert.equal((await request("settings")).response.status, 401);
  const page = await (await fetch(`${base}/admin`)).text();
  assert.ok(page.includes("ADMIN PANEL"));
  console.log("Admin API checks passed: setup, login, protected access, save, edit, token masking/removal, validation, origin checks, and logout.");
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
