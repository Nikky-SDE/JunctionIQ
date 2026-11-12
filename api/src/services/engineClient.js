export class EngineError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export class HttpRoutingEngine {
  constructor(baseUrl, timeoutMs = 5000) {
    this.baseUrl = (baseUrl || "http://127.0.0.1:7070").replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  async route(query) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(query),
        signal,
      });
    } catch (e) {
      throw new EngineError(`routing engine unreachable: ${e.message}`, 503, "unavailable");
    }

    const body = await res.json().catch(() => null);
    if (res.status === 400) {
      throw new EngineError(body?.error || "invalid query", 400, "invalid");
    }
    if (!res.ok || !body) {
      throw new EngineError(`routing engine error (HTTP ${res.status})`, 502, "unavailable");
    }
    return body;
  }

  async health() {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`engine health HTTP ${res.status}`);
    return await res.json();
  }
}

/**
 * Tries the primary HTTP C++ engine when configured, and falls back seamlessly
 * to the in-process JavaScript routing engine if the C++ daemon is unavailable.
 */
export class HybridRoutingEngine {
  constructor(httpEngine, jsEngine, mode = "auto") {
    this.httpEngine = httpEngine;
    this.jsEngine = jsEngine;
    this.mode = mode; // "auto" | "http" | "js"
  }

  async route(query) {
    if (this.mode === "js" || !this.httpEngine) {
      return this.jsEngine.route(query);
    }
    if (this.mode === "http") {
      return this.httpEngine.route(query);
    }
    try {
      return await this.httpEngine.route(query);
    } catch (err) {
      if (err instanceof EngineError && err.kind === "invalid") throw err;
      return this.jsEngine.route(query);
    }
  }

  async health() {
    if (this.mode !== "js" && this.httpEngine) {
      try {
        return await this.httpEngine.health();
      } catch {
        if (this.mode === "http") throw new Error("C++ routing engine unavailable");
      }
    }
    return this.jsEngine.health();
  }
}
