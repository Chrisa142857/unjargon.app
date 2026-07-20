function sameSecret(got, expected) {
  if (!got || !expected) return false;
  let different = got.length ^ expected.length;
  for (let i = 0; i < Math.max(got.length, expected.length); i++) {
    different |= (got.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return different === 0;
}

function validParams(params) {
  return Array.isArray(params) && params.every((value) =>
    value === null || ["string", "number", "boolean"].includes(typeof value),
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/query") {
      return new Response("not found", { status: 404 });
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !sameSecret(authorization.slice(7), env.D1_GATEWAY_TOKEN)) {
      return new Response("unauthorized", { status: 401 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      typeof body?.sql !== "string" || !body.sql.trim() || body.sql.length > 100_000 ||
      !validParams(body.params) || !["run", "all", "values", "get"].includes(body.method)
    ) {
      return Response.json({ error: "invalid query" }, { status: 400 });
    }

    try {
      const statement = env.DB.prepare(body.sql).bind(...body.params);
      if (body.method === "run") {
        await statement.run();
        return Response.json({ rows: [] }, { headers: { "Cache-Control": "no-store" } });
      }
      const rows = await statement.raw();
      return Response.json(
        { rows: body.method === "get" ? (rows[0] ?? null) : rows },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      console.error("D1 query failed", error);
      return Response.json({ error: "database query failed" }, { status: 500 });
    }
  },
};
