// Exercise compiled routes, real auth and disposable D1/relay instances.
import assert from "node:assert/strict";
import { withLocalSmokeFixture } from "./local-smoke-fixture.mjs";
const future = "2090-01-01T00:00:00.000Z";
await withLocalSmokeFixture(
  async ({ origin, orgId, date, operatorCookie, queryFixture }) => {
    const headers = {
      Cookie: operatorCookie,
      Origin: origin,
      "Content-Type": "application/json",
    };
    async function call(path, body, status = 200) {
      const response = await fetch(`${origin}${path}`, {
        headers,
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    }
    const rows = () =>
      queryFixture(
        "SELECT id,name,updatedAt FROM rundown WHERE orgId='display-smoke' AND id LIKE 'timestamp-%' ORDER BY id",
      );
    const row = async (showId) => {
      const found = (await rows()).find((value) => value.id === showId);
      assert.ok(found, `Missing fixture ${showId}`);
      return found;
    };
    for (const format of ["numeric", "prisma", "sqlite"]) {
      const showId = `timestamp-${format}-details`;
      const path = `/api/mobile/v1/rundowns/${showId}/details`;
      const query = `?orgId=${orgId}&userId=smoke-operator`;
      const current = await call(path + query);
      assert.equal(current.snapshot.updatedAt, future);
      const command = {
        orgId,
        userId: "smoke-operator",
        showId,
        serviceDate: date,
        requestId: crypto.randomUUID(),
        expectedRevision: current.revision,
        expectedUpdatedAt: current.snapshot.updatedAt,
        name: "Details saved",
        location: "Fixture venue",
        startTime: "",
        callTime: "",
        timeZone: current.timeZone,
      };
      assert.equal(
        (await call(`${path}/command${query}`, command)).outcome,
        "applied",
      );
      const applied = await row(showId);
      assert.equal(applied.name, command.name);
      assert.ok(Date.parse(applied.updatedAt) > Date.parse(future));
      assert.equal(
        (await call(`${path}/command${query}`, command)).outcome,
        "applied",
      );
      assert.deepEqual(await row(showId), applied);
      assert.equal(
        (
          await call(`${path}/command${query}`, {
            ...command,
            requestId: crypto.randomUUID(),
            name: "Stale save",
          })
        ).outcome,
        "conflict",
      );
      assert.deepEqual(await row(showId), applied);

      const metaId = `timestamp-${format}-metadata`;
      const metaPath = `/api/rundown/${orgId}/command?showId=${metaId}&serviceDate=${date}`;
      const meta = {
        serviceName: "Metadata saved",
        location: "Main room",
        scheduledStartTime: null,
        scheduledCallTime: null,
        expectedUpdatedAt: future,
      };
      await call(metaPath, {
        id: crypto.randomUUID(),
        action: "update-meta",
        payload: meta,
      });
      const savedMeta = await row(metaId);
      assert.equal(savedMeta.name, meta.serviceName);
      assert.ok(Date.parse(savedMeta.updatedAt) > Date.parse(future));
      await call(
        metaPath,
        {
          id: crypto.randomUUID(),
          action: "update-meta",
          payload: { ...meta, serviceName: "Stale metadata" },
        },
        409,
      );
      assert.deepEqual(await row(metaId), savedMeta);

      const timerId = `timestamp-${format}-timer`;
      const timerPath = `/api/rundown/${orgId}/command?showId=${timerId}&serviceDate=${date}`;
      await call(timerPath, {
        id: crypto.randomUUID(),
        action: "seed",
        payload: {
          items: [
            {
              id: "cue",
              title: "Timestamp cue",
              type: "segment",
              duration: 60000,
              notes: "",
              assignee: "",
              cue: "",
              status: "upcoming",
              sortOrder: 0,
              hardStop: false,
            },
          ],
        },
      });
      const seeded = await row(timerId);
      await call(timerPath, {
        id: crypto.randomUUID(),
        action: "timer-start",
        payload: { itemId: "cue" },
      });
      const started = await row(timerId);
      assert.ok(Date.parse(started.updatedAt) > Date.parse(seeded.updatedAt));
      await call(timerPath, {
        id: crypto.randomUUID(),
        action: "timer-stop",
        payload: {},
      });
      assert.ok(
        Date.parse((await row(timerId)).updatedAt) >
          Date.parse(started.updatedAt),
      );
    }
    console.log(
      JSON.stringify({
        result: "pass",
        compiledWorker: true,
        realAuth: true,
        formats: ["numeric", "prisma-iso-offset", "sqlite-utc"],
        detailReplay: true,
        staleVersionsRejected: true,
        timerVersionsAdvance: true,
      }),
    );
  },
  { timestampVersions: true },
);
