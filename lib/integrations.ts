export const INTEGRATIONS = [
  { name: "Redash", route: "/api/redash", description: "Run queries using the Redash API key configured on the server." },
  { name: "User lookup", route: "/api/users", description: "Profiles, company records, assignments, calls, meetings, and Global Context for comma-separated GLIDs." },
  { name: "Global Context", route: "/api/global-context", description: "Generate a mapping ID for each GLID, then retrieve all seven context segments using the shared token and employee ID." },
  { name: "Best time to call", route: "/api/predictions", description: "Batch completed-meeting recommendations, eligible windows, retry constraints, and grounded GPT-6 Luna review or deterministic fallback." },
];
