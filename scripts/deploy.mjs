// Uploads the cottage bookings notebook to Cloudflare in one go:
//   1. the "cotage-notepad" Worker (the site itself, accounts, notebooks,
//      live sync),
//   2. the "javshnebi" Pages front door at https://javshnebi.pages.dev, which
//      forwards every request to the Worker.
// Later updates only need the Worker (this script or a GitHub push); the front
// door never changes. Run it with upload-to-cloudflare.cmd or `npm run deploy`.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

const PAGES_PROJECT = "javshnebi";
const WORKER = "cotage-notepad";
const project = fileURLToPath(new URL("..", import.meta.url));
const wrangler = join(project, "node_modules", "wrangler", "bin", "wrangler.js");
const secretsPath = join(project, "deployment-secrets.json");

function run(args, { cwd = project, quiet = false } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [wrangler, ...args], {
      cwd,
      stdio: quiet ? ["inherit", "pipe", "pipe"] : "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    if (quiet) {
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? done(output)
        : fail(Object.assign(new Error("ბრძანება ვერ შესრულდა. შეცდომა ზემოთაა."), { output }))
    );
  });
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const say = (text) => process.stdout.write(text + "\n");

async function prepareSecrets() {
  let values = {};
  try {
    values = JSON.parse(await readFile(secretsPath, "utf8"));
  } catch {}
  if (!values.GOOGLE_CLIENT_ID || !values.GOOGLE_CLIENT_SECRET) {
    say("Google-ით შესვლა (თუ ჯერ არ გაქვს Google-ის გასაღებები, უბრალოდ დააჭირე Enter-ს და მოგვიანებით დაამატებ).");
    say("იგივე გასაღებები გამოდგება, რაც შეკვეთების საიტზე ჩაწერე.");
    const id = await ask("Google Client ID: ");
    if (id) {
      const secret = await ask("Google Client Secret: ");
      if (!secret) throw new Error("Client Secret ცარიელია. თავიდან გაუშვი და ორივე ჩაწერე.");
      values.GOOGLE_CLIENT_ID = id;
      values.GOOGLE_CLIENT_SECRET = secret;
    }
  }
  if (Object.keys(values).length) await writeFile(secretsPath, JSON.stringify(values, null, 2));
  return values;
}

// The front door only holds a tiny forwarding script.
async function pagesFolder() {
  const root = await mkdtemp(join(tmpdir(), PAGES_PROJECT + "-"));
  const dist = join(root, "dist");
  await mkdir(dist);
  await cp(join(project, "pages-site", "_worker.js"), join(dist, "_worker.js"));
  await cp(join(project, "pages-site", "_routes.json"), join(dist, "_routes.json"));
  await writeFile(join(dist, "robots.txt"), "User-agent: *\nAllow: /\n");
  await writeFile(
    join(root, "wrangler.json"),
    JSON.stringify(
      {
        name: PAGES_PROJECT,
        pages_build_output_dir: "./dist",
        compatibility_date: "2026-10-08",
        services: [{ binding: "API", service: WORKER }],
      },
      null,
      2
    )
  );
  return root;
}

const domainIn = (text) => {
  const found = [...String(text).matchAll(/([a-z0-9-]+\.pages\.dev)/g)].map((match) => match[1]);
  return found.find((domain) => domain === `${PAGES_PROJECT}.pages.dev`) || found.find((domain) => domain.startsWith(PAGES_PROJECT + "-")) || null;
};

async function deployFrontDoor() {
  const root = await pagesFolder();
  try {
    let domain = null;
    try {
      domain = domainIn(await run(["pages", "project", "create", PAGES_PROJECT, "--production-branch", "main"], { cwd: root, quiet: true }));
      say("Pages პროექტი შეიქმნა.");
    } catch (error) {
      if (!/already exists|8000002|taken/i.test(error.output || "")) say("(Pages პროექტი ვერ შეიქმნა ან უკვე არსებობს — ვცდი ატვირთვას.)");
    }
    if (!domain) domain = domainIn(await run(["pages", "project", "list"], { cwd: root, quiet: true }).catch(() => ""));
    await run(["pages", "deploy", "--project-name", PAGES_PROJECT, "--branch", "main", "--commit-dirty=true"], { cwd: root });
    return "https://" + (domain || `${PAGES_PROJECT}.pages.dev`);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

// From now on the old workers.dev address sends visitors to the front door.
async function rememberPublicUrl(values, url) {
  if (values.PUBLIC_URL === url) return;
  values.PUBLIC_URL = url;
  await writeFile(secretsPath, JSON.stringify(values, null, 2));
  const folder = await mkdtemp(join(tmpdir(), WORKER + "-url-"));
  try {
    await writeFile(join(folder, "secret.json"), JSON.stringify({ PUBLIC_URL: url }));
    await run(["secret", "bulk", join(folder, "secret.json")]);
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (process.env.WORKERS_CI || process.env.CI) {
    // Automatic build (Cloudflare's GitHub integration): only the Worker. The
    // front door and the secrets were set up once from a computer.
    await run(["deploy"]);
    return;
  }
  say("\nაგარაკის ჯავშნები — ატვირთვა Cloudflare-ზე\n");
  say("ნაბიჯი 1/3: Cloudflare-ში შესვლის შემოწმება. თუ ბრაუზერი გაიხსნება, დაადასტურე (Allow).");
  try {
    await run(["whoami"], { quiet: true });
  } catch {
    await run(["login"]);
  }

  say("\nნაბიჯი 2/3: საიტი და სერვერი (ექაუნთები, ჯავშნები, ცოცხალი სინქრონიზაცია).");
  const values = await prepareSecrets();
  await run(Object.keys(values).length ? ["deploy", "--secrets-file", secretsPath] : ["deploy"]);

  say(`\nნაბიჯი 3/3: მისამართი ${PAGES_PROJECT}.pages.dev.`);
  const url = await deployFrontDoor();
  await rememberPublicUrl(values, url);

  say(`\nმზადაა! საიტი: ${url}`);
  say("ძველი მისამართი ავტომატურად ახალზე გადაგიყვანს.");
  say("deployment-secrets.json პირადი ფაილია. შეინახე და არავის გაუზიარო.");
}

main().catch((error) => {
  process.stderr.write("\n" + (error.message || error) + "\n");
  process.exitCode = 1;
});
