import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const videoDirectory = resolve("artifacts", "dashboard-demo");
const finalVideoPath = resolve(videoDirectory, "dashboard-flow.webm");

await mkdir(videoDirectory, { recursive: true });

const timestamp = "2026-07-22T03:20:00.000Z";
const project = {
  id: 101,
  name: "UNI ACCESS 데모 프로젝트",
  type: "ETC",
  homepageUrl: "https://www.hongik.ac.kr",
  description: "대학 웹사이트의 접근성 개선 항목을 관리합니다.",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const target = {
  id: 501,
  organizationId: project.id,
  name: "홍익대학교 메인",
  targetType: "WEB",
  accessUrl: "https://www.hongik.ac.kr",
  description: "대학 대표 홈페이지",
  status: "ACTIVE",
  createdAt: timestamp,
  updatedAt: timestamp
};
const evaluationRequest = {
  id: 701,
  evaluationTargetId: target.id,
  targetName: target.name,
  status: "PENDING",
  requestNote: "대시보드 데모 분석",
  requestedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp
};

let projectCreated = false;
let targetCreated = false;
let requestCreated = false;
let analysisCompleted = false;
let pollCount = 0;

function envelope(data) {
  return { success: true, data, message: null };
}

function requestWithStatus(status) {
  return {
    ...evaluationRequest,
    status,
    updatedAt: status === "COMPLETED" ? "2026-07-22T03:20:08.000Z" : timestamp
  };
}

async function fulfillJson(route, data, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify(envelope(data))
  });
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "no-preference",
  recordVideo: {
    dir: videoDirectory,
    size: { width: 1920, height: 1080 }
  }
});
const page = await context.newPage();
const recordedVideo = page.video();
page.setDefaultTimeout(5000);

page.on("pageerror", (error) => {
  console.error(`[page error] ${error.message}`);
});

await page.addInitScript(() => {
  const removeBootstrapOverlay = () => {
    for (const section of document.querySelectorAll("section")) {
      if (section.textContent?.includes("대시보드를 불러오는 중...")) {
        section.style.opacity = "0";
        section.style.pointerEvents = "none";
        section.style.visibility = "hidden";
      }
    }
  };

  const observePage = () => {
    if (!document.documentElement) {
      window.setTimeout(observePage, 0);
      return;
    }

    removeBootstrapOverlay();
    new MutationObserver(removeBootstrapOverlay).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  observePage();
});

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const method = request.method();
  const pathname = new URL(request.url()).pathname.replace(/^\/api/, "");

  if (pathname === "/organizations" && method === "GET") {
    await fulfillJson(route, projectCreated ? [project] : []);
    return;
  }

  if (pathname === "/organizations" && method === "POST") {
    projectCreated = true;
    await fulfillJson(route, project, 201);
    return;
  }

  if (pathname === `/organizations/${project.id}/evaluation-targets` && method === "GET") {
    await fulfillJson(route, targetCreated ? [target] : []);
    return;
  }

  if (pathname === `/organizations/${project.id}/evaluation-targets` && method === "POST") {
    targetCreated = true;
    await fulfillJson(route, target, 201);
    return;
  }

  if (pathname === "/requests" && method === "GET") {
    const requests = requestCreated
      ? [requestWithStatus(analysisCompleted ? "COMPLETED" : "PENDING")]
      : [];
    await fulfillJson(route, requests);
    return;
  }

  if (pathname === "/requests" && method === "POST") {
    requestCreated = true;
    pollCount = 0;
    await fulfillJson(route, requestWithStatus("PENDING"), 201);
    return;
  }

  if (pathname === `/requests/${evaluationRequest.id}` && method === "GET") {
    pollCount += 1;
    const status = pollCount >= 2 ? "COMPLETED" : "RUNNING";
    analysisCompleted = status === "COMPLETED";
    await fulfillJson(route, requestWithStatus(status));
    return;
  }

  if (pathname === `/results/requests/${evaluationRequest.id}/summary` && method === "GET") {
    await fulfillJson(route, {
      requestId: evaluationRequest.id,
      targetName: target.name,
      status: "COMPLETED",
      totalScore: 86,
      totalIssueCount: 3,
      criticalIssueCount: 1,
      requestedAt: timestamp
    });
    return;
  }

  if (pathname === `/results/requests/${evaluationRequest.id}/issues` && method === "GET") {
    await fulfillJson(route, [
      {
        id: 9001,
        requestId: evaluationRequest.id,
        module: "rule_based",
        severity: "SERIOUS",
        title: "이미지 대체 텍스트가 비어 있습니다",
        description: "대표 이미지에 의미를 전달하는 대체 텍스트가 없습니다.",
        recommendation: "이미지의 목적과 내용을 간결한 대체 텍스트로 작성하세요.",
        selector: "main .hero-visual img",
        wcagCode: "1.1.1",
        createdAt: timestamp
      },
      {
        id: 9002,
        requestId: evaluationRequest.id,
        module: "text_difficulty",
        severity: "MODERATE",
        title: "본문 문장이 지나치게 깁니다",
        description: "한 문장에 여러 안내 내용이 포함되어 읽기 어렵습니다.",
        recommendation: "핵심 정보를 짧은 문장과 목록으로 나누세요.",
        selector: "main .admission-guide p",
        wcagCode: "3.1.5",
        createdAt: timestamp
      },
      {
        id: 9003,
        requestId: evaluationRequest.id,
        module: "cv_visual",
        severity: "MINOR",
        title: "텍스트 대비가 충분하지 않습니다",
        description: "보조 문구와 배경 사이의 명도 대비가 낮습니다.",
        recommendation: "텍스트와 배경의 대비를 4.5:1 이상으로 조정하세요.",
        selector: ".notice-card .description",
        wcagCode: "1.4.3",
        createdAt: timestamp
      }
    ]);
    return;
  }

  if (pathname === `/scores/requests/${evaluationRequest.id}` && method === "GET") {
    await fulfillJson(route, {
      id: 801,
      evaluationRequestId: evaluationRequest.id,
      totalScore: 86,
      ruleScore: 82,
      aiScore: 88,
      cvScore: 87,
      createdAt: timestamp,
      updatedAt: "2026-07-22T03:20:08.000Z"
    });
    return;
  }

  await route.fulfill({
    status: 404,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ success: false, message: `Unhandled demo API: ${method} ${pathname}` })
  });
});

async function addDemoCursor() {
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes uni-demo-click {
        from { opacity: 0.9; transform: translate(-50%, -50%) scale(0.25); }
        to { opacity: 0; transform: translate(-50%, -50%) scale(2.2); }
      }
      #uni-demo-cursor {
        position: fixed;
        z-index: 2147483647;
        width: 18px;
        height: 18px;
        border: 2px solid #0f172a;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.82);
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.3);
        pointer-events: none;
        transform: translate(-50%, -50%);
        transition: left 560ms cubic-bezier(0.22, 1, 0.36, 1), top 560ms cubic-bezier(0.22, 1, 0.36, 1);
      }
      .uni-demo-pulse {
        position: fixed;
        z-index: 2147483646;
        width: 18px;
        height: 18px;
        border: 2px solid rgba(239, 106, 80, 0.9);
        border-radius: 999px;
        pointer-events: none;
        animation: uni-demo-click 560ms ease-out forwards;
      }
    `;
    document.head.append(style);

    const cursor = document.createElement("div");
    cursor.id = "uni-demo-cursor";
    cursor.style.left = "78vw";
    cursor.style.top = "70vh";
    document.body.append(cursor);
  });
}

async function moveTo(locator) {
  await locator.waitFor({ state: "visible" });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Could not locate dashboard demo target.");

  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.evaluate(({ x, y }) => {
    const cursor = document.querySelector("#uni-demo-cursor");
    if (cursor instanceof HTMLElement) {
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }
  }, point);
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(680);
  return point;
}

async function showClick(point) {
  await page.evaluate(({ x, y }) => {
    const pulse = document.createElement("div");
    pulse.className = "uni-demo-pulse";
    pulse.style.left = `${x}px`;
    pulse.style.top = `${y}px`;
    document.body.append(pulse);
    window.setTimeout(() => pulse.remove(), 600);
  }, point);
}

async function moveAndClick(locator) {
  const point = await moveTo(locator);
  await showClick(point);
  await locator.click();
  await page.waitForTimeout(520);
}

async function typeInto(locator, text) {
  await moveAndClick(locator);
  await locator.pressSequentially(text, { delay: 42 });
  await page.waitForTimeout(380);
}

try {
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  await addDemoCursor();

  await moveAndClick(page.getByRole("button", { name: "사이드바 열기", exact: true }));
  await moveAndClick(page.locator("button.sidebar-nav-link").nth(1));
  await page.waitForURL("**/projects");

  await moveAndClick(page.locator("button.project-header-create-trigger"));
  const projectDialog = page.getByRole("dialog", { name: "프로젝트 추가", exact: true });
  await typeInto(projectDialog.getByLabel("프로젝트 이름", { exact: true }), project.name);
  await typeInto(projectDialog.getByLabel("설명", { exact: true }), project.description);
  await moveAndClick(projectDialog.getByRole("button", { name: "생성", exact: true }));
  await projectDialog.waitFor({ state: "hidden" });

  const projectsTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "설명", exact: true })
  });
  const projectRow = projectsTable.getByRole("row").filter({
    has: page.getByText(project.name, { exact: true })
  });
  await moveAndClick(projectRow);
  await page.waitForURL(`**/projects/${project.id}`);

  await moveAndClick(page.getByRole("button", { name: "페이지 추가" }));
  const siteDialog = page.getByRole("dialog", { name: project.name, exact: true });
  await typeInto(siteDialog.getByLabel("페이지 이름", { exact: true }), target.name);
  await typeInto(siteDialog.getByLabel("페이지 주소", { exact: true }), target.accessUrl);
  await moveAndClick(siteDialog.getByRole("button", { name: "분석 시작", exact: true }));
  await siteDialog.getByText("분석 진행 중", { exact: true }).waitFor({ state: "visible" });
  await siteDialog.getByText("분석이 완료되었습니다.", { exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await siteDialog.waitFor({ state: "hidden", timeout: 15000 });

  const pagesTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "주소", exact: true })
  });
  const pageRow = pagesTable.getByRole("row").filter({
    has: page.getByText(target.name, { exact: true })
  });
  await moveAndClick(pageRow);
  await page.waitForURL(`**/projects/${project.id}/pages/${target.id}`);

  const recentIssuesHeading = page.getByRole("heading", { name: "최근 발견 이슈" });
  await recentIssuesHeading.waitFor({ state: "visible" });
  await moveTo(recentIssuesHeading);
  await page.waitForTimeout(2600);
} finally {
  await context.close();
  await browser.close();
}

if (!recordedVideo) {
  throw new Error("Playwright did not create a dashboard recording.");
}

const temporaryVideoPath = await recordedVideo.path();
await copyFile(temporaryVideoPath, finalVideoPath);
if (temporaryVideoPath !== finalVideoPath) {
  await rm(temporaryVideoPath, { force: true });
}

console.log(`Dashboard demo recorded at ${finalVideoPath}`);
