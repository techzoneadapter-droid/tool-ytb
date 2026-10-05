import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  POST as videosPOST,
  GET as videosGET,
} from "../../app/api/videos/route";
import { POST as studioPOST } from "../../app/api/studio/route";
import { get, list, put, root, remove } from "../../modules/project/store";
import {
  defaults,
  type Project,
  type Job,
  type VideoRecord,
} from "../../modules/project/types";
const cases: { name: string; passed: boolean }[] = [];
const project = () => {
  const p: Project = {
    id: randomUUID(),
    name: "delete fixture",
    chapters: [],
    settings: defaults,
    createdAt: new Date().toISOString(),
  };
  put("project", p);
  return p;
};
async function video(
  p: Project,
  output = randomUUID() + ".mp4",
  missing = false,
) {
  const v: VideoRecord = {
    id: randomUUID(),
    projectId: p.id,
    chapterIds: [],
    chapterTitles: [],
    title: "fixture",
    kind: "merged",
    output,
    srt: output.replace(".mp4", ".srt"),
    vtt: output.replace(".mp4", ".vtt"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    duration: 1,
    width: 640,
    height: 360,
    fileSize: 7,
    verified: true,
    version: 1,
  };
  put("video", v);
  if (!missing)
    for (const file of [v.output, v.srt!, v.vtt!])
      await writeFile(path.join(root, "assets", file), "fixture");
  return v;
}
const exists = async (file: string) =>
  access(path.join(root, "assets", file)).then(
    () => true,
    () => false,
  );
async function post(
  route: (req: NextRequest) => Promise<Response>,
  body: object,
  status = 200,
) {
  const r = await route(
    new NextRequest("http://localhost/api", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify(body),
    }),
  );
  const data = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
async function run(name: string, action: () => Promise<void>) {
  await action();
  cases.push({ name, passed: true });
}
async function main() {
  await mkdir(path.join(root, "assets"), { recursive: true });
  await run("delete one video", async () => {
    const p = project(),
      v = await video(p);
    const source = randomUUID() + ".png";
    await writeFile(path.join(root, "assets", source), "source");
    assert.equal(
      (await post(videosPOST, { action: "deleteMany", videoIds: [v.id] }))
        .deleted,
      1,
    );
    assert.ok(!list<VideoRecord>("video").some((x) => x.id === v.id));
    assert.ok(!(await exists(v.output)));
    assert.ok(await exists(source));
    assert.equal(get<Project>(p.id, "project").id, p.id);
  });
  await run("delete 20 videos in one request", async () => {
    const p = project();
    const items = await Promise.all(Array.from({ length: 20 }, () => video(p)));
    assert.equal(
      (
        await post(videosPOST, {
          action: "deleteMany",
          videoIds: items.map((v) => v.id),
        })
      ).deleted,
      20,
    );
    for (const v of items) assert.ok(!(await exists(v.output)));
  });
  const sharedProject = project(),
    a = await video(sharedProject),
    b = await video(sharedProject, a.output);
  await run("shared MP4/SRT/VTT retained until last reference", async () => {
    await post(videosPOST, { action: "deleteMany", videoIds: [a.id] });
    for (const name of [a.output, a.srt!, a.vtt!])
      assert.ok(await exists(name));
  });
  await run("last record unlinks shared MP4/SRT/VTT", async () => {
    await post(videosPOST, { action: "delete", videoId: b.id });
    for (const name of [a.output, a.srt!, a.vtt!])
      assert.ok(!(await exists(name)));
  });
  await run("duplicate video IDs deduplicated", async () => {
    const v = await video(project());
    assert.equal(
      (await post(videosPOST, { action: "deleteMany", videoIds: [v.id, v.id] }))
        .deleted,
      1,
    );
  });
  await run("missing files still delete record", async () => {
    const v = await video(project(), randomUUID() + ".mp4", true);
    assert.equal(
      (await post(videosPOST, { action: "deleteMany", videoIds: [v.id] }))
        .deleted,
      1,
    );
  });
  await run(
    "delete five projects cascades jobs/history/videos, keeps source media",
    async () => {
      const projects = Array.from({ length: 5 }, project),
        items = await Promise.all(projects.map((p) => video(p)));
      const source = randomUUID() + ".wav";
      await writeFile(path.join(root, "assets", source), "source");
      for (const p of projects) {
        put("job", {
          id: randomUUID(),
          projectId: p.id,
          chapterIds: [],
          status: "done",
          progress: 100,
          message: "",
          createdAt: p.createdAt,
          snapshot: { settings: defaults },
        });
        put("image_generation_history", { id: randomUUID(), projectId: p.id });
      }
      const ids = projects.map((p) => p.id);
      assert.equal(
        (
          await post(studioPOST, {
            action: "deleteProjects",
            projectIds: [...ids, ids[0]],
          })
        ).deleted,
        5,
      );
      for (const kind of [
        "project",
        "job",
        "video",
        "image_generation_history",
      ])
        assert.ok(
          !list<{ id: string; projectId?: string }>(kind).some((x) =>
            ids.includes(x.projectId || x.id),
          ),
        );
      for (const v of items) assert.ok(!(await exists(v.output)));
      assert.ok(await exists(source));
    },
  );
  await run(
    "every active status including paused rejects whole batch",
    async () => {
      for (const status of [
        "queued",
        "audio",
        "images",
        "rendering",
        "paused",
      ] as const) {
        const p = project(),
          untouched = project(),
          v = await video(untouched);
        const j: Job = {
          id: randomUUID(),
          projectId: p.id,
          chapterIds: [],
          status,
          progress: 0,
          message: "",
          createdAt: p.createdAt,
          snapshot: { settings: defaults },
        };
        put("job", j);
        const r = await post(
          studioPOST,
          { action: "deleteProjects", projectIds: [untouched.id, p.id] },
          400,
        );
        assert.match(r.error, /Không thể xóa 1 dự án/);
        assert.equal(get<Project>(untouched.id, "project").id, untouched.id);
        assert.ok(await exists(v.output));
        assert.equal(get<Job>(j.id, "job").status, status);
        remove("job", j.id);
      }
    },
  );
  await run("delete A preserves B and cross-project shared files", async () => {
    const a = project(),
      b = project(),
      av = await video(a),
      bv = await video(b, av.output);
    await post(studioPOST, { action: "deleteProjects", projectIds: [a.id] });
    assert.equal(get<Project>(b.id, "project").id, b.id);
    assert.equal(get<VideoRecord>(bv.id, "video").output, av.output);
    assert.ok(await exists(av.output));
  });
  await run(
    "invalid/empty/over-limit arrays rejected without mutation",
    async () => {
      const p = project(),
        v = await video(p);
      for (const videoIds of [[], [v.id, "invalid"], Array(501).fill(v.id)])
        await post(videosPOST, { action: "deleteMany", videoIds }, 400);
      for (const projectIds of [[], [p.id, "invalid"], Array(101).fill(p.id)])
        await post(studioPOST, { action: "deleteProjects", projectIds }, 400);
      assert.equal(get<VideoRecord>(v.id, "video").id, v.id);
    },
  );
  await run(
    "deleted legacy record cannot resurrect from job migration",
    async () => {
      const p = project(),
        v = await video(p),
        jobId = randomUUID();
      v.sourceJobId = jobId;
      put("video", { ...v });
      put("job", {
        id: jobId,
        projectId: p.id,
        chapterIds: [],
        status: "done",
        output: v.output,
        verified: true,
        progress: 100,
        message: "",
        createdAt: p.createdAt,
        snapshot: { settings: defaults },
      });
      // Retain the output through a second record, so migration could otherwise recreate it.
      await video(p, v.output);
      await post(videosPOST, { action: "deleteMany", videoIds: [v.id] });
      assert.ok(get<Job>(jobId, "job").videoLibraryDeleted);
      const before = list<VideoRecord>("video").length;
      await videosGET();
      assert.equal(list<VideoRecord>("video").length, before);
    },
  );
  await run(
    "Flow scene source cache retained and unsafe asset path never unlinked",
    async () => {
      const p = project(),
        v = await video(p);
      p.chapters = [
        {
          id: randomUUID(),
          title: "",
          text: "",
          scenes: [
            {
              id: randomUUID(),
              text: "",
              prompt: "",
              duration: 1,
              approved: true,
              flow: {
                sceneId: randomUUID(),
                chapterId: randomUUID(),
                status: "done",
                prompt: "",
                videoPath: v.output,
                updatedAt: p.createdAt,
              },
            },
          ],
        },
      ];
      put("project", p);
      await post(videosPOST, { action: "deleteMany", videoIds: [v.id] });
      assert.ok(await exists(v.output));
      const evil = await video(p, "../keep.mp4", true);
      await writeFile(path.join(root, "keep.mp4"), "keep");
      await post(videosPOST, { action: "deleteMany", videoIds: [evil.id] });
      await access(path.join(root, "keep.mp4"));
    },
  );
  process.stdout.write(JSON.stringify(cases));
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
