import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const PRODUCT_CONTRACTS = {
  desktop: {
    packagePath: "apps/desktop/package.json",
    cargoPath: "apps/desktop/src-tauri/Cargo.toml",
    cargoLockPath: "apps/desktop/src-tauri/Cargo.lock",
    tauriPath: "apps/desktop/src-tauri/tauri.conf.json",
    releaseConfigPath: "apps/desktop/ci-release.conf.json",
    workflowPath: ".github/workflows/desktop-release.yml",
    cargoName: "showpilot-desktop",
    identifier: "tech.showpilot.desktop",
    productName: "ShowPilot Desktop",
    projectPath: "apps/desktop",
    tagPrefix: "desktop-v",
    updaterEndpoint: "https://www.showpilot.tech/updates/desktop/latest.json",
    landingIds: [
      "desktop-macos-arm64",
      "desktop-macos-x64",
      "desktop-windows-x64",
    ],
  },
  bridge: {
    packagePath: "apps/bridge-desktop/package.json",
    cargoPath: "apps/bridge-desktop/src-tauri/Cargo.toml",
    cargoLockPath: "apps/bridge-desktop/src-tauri/Cargo.lock",
    tauriPath: "apps/bridge-desktop/src-tauri/tauri.conf.json",
    releaseConfigPath: "apps/bridge-desktop/ci-release.conf.json",
    workflowPath: ".github/workflows/bridge-release.yml",
    cargoName: "showpilot-bridge-desktop",
    identifier: "tech.showpilot.bridge",
    productName: "ShowPilot Bridge",
    projectPath: "apps/bridge-desktop",
    tagPrefix: "bridge-v",
    updaterEndpoint: "https://www.showpilot.tech/updates/bridge/latest.json",
    landingIds: [
      "bridge-macos-arm64",
      "bridge-macos-x64",
      "bridge-windows-x64",
    ],
  },
};

function readJson(root, path) {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function readText(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

function cargoPackage(text) {
  const section = text.match(/^\[package\]\s*([\s\S]*?)(?=^\[|\Z)/m)?.[1] ?? "";
  return {
    name: section.match(/^name\s*=\s*"([^"]+)"/m)?.[1],
    version: section.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  };
}

function cargoLockVersion(text, packageName) {
  const sections = text.split(/^\[\[package\]\]\s*$/m).slice(1);
  for (const section of sections) {
    if (section.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === packageName) {
      return section.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    }
  }
  return undefined;
}

function updaterPublicKeyIsValid(encoded) {
  if (typeof encoded !== "string" || encoded.length < 80) return false;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const lines = decoded.trim().split(/\r?\n/);
    return (
      lines.length === 2 &&
      /^untrusted comment: minisign public key:/i.test(lines[0]) &&
      /^[A-Za-z0-9+/=]{40,120}$/.test(lines[1])
    );
  } catch {
    return false;
  }
}

function productSnapshot(root, product) {
  const contract = PRODUCT_CONTRACTS[product];
  const packageJson = readJson(root, contract.packagePath);
  const cargoText = readText(root, contract.cargoPath);
  const cargoLockText = readText(root, contract.cargoLockPath);
  const tauri = readJson(root, contract.tauriPath);
  const cargo = cargoPackage(cargoText);
  return {
    packageVersion: packageJson.version,
    cargoName: cargo.name,
    cargoVersion: cargo.version,
    cargoLockVersion: cargoLockVersion(cargoLockText, contract.cargoName),
    tauri,
    releaseConfig: readJson(root, contract.releaseConfigPath),
    workflow: readText(root, contract.workflowPath),
  };
}

export function loadNativeReleaseSnapshot(root) {
  return {
    products: {
      desktop: productSnapshot(root, "desktop"),
      bridge: productSnapshot(root, "bridge"),
    },
    bridgeEngineVersion: readJson(root, "apps/bridge/package.json").version,
    landingHtml: readText(root, "apps/landing/src/index.template.html"),
    landingWorker: readText(root, "apps/landing/src/worker.ts"),
    landingWrangler: readJson(root, "apps/landing/wrangler.jsonc"),
  };
}

function includesEvery(text, fragments) {
  return fragments.filter((fragment) => !text.includes(fragment));
}

export function findNativeReleaseIssues(snapshot, options = {}) {
  const issues = [];
  const add = (condition, message) => {
    if (!condition) issues.push(message);
  };

  for (const [product, contract] of Object.entries(PRODUCT_CONTRACTS)) {
    const current = snapshot.products[product];
    const versions = {
      package: current.packageVersion,
      Cargo: current.cargoVersion,
      "Cargo.lock": current.cargoLockVersion,
      Tauri: current.tauri.version,
      ...(product === "bridge"
        ? { "embedded engine": snapshot.bridgeEngineVersion }
        : {}),
    };
    const uniqueVersions = new Set(Object.values(versions));
    add(
      uniqueVersions.size === 1 && !uniqueVersions.has(undefined),
      `${contract.productName} versions must match (${Object.entries(versions)
        .map(([source, version]) => `${source}=${version ?? "missing"}`)
        .join(", ")}).`,
    );
    add(
      typeof current.packageVersion === "string" &&
        SEMVER.test(current.packageVersion),
      `${contract.productName} version must be valid semantic versioning.`,
    );
    add(
      current.cargoName === contract.cargoName,
      `${contract.productName} Cargo package must be ${contract.cargoName}.`,
    );
    add(
      current.tauri.productName === contract.productName,
      `${contract.productName} Tauri product name changed unexpectedly.`,
    );
    add(
      current.tauri.identifier === contract.identifier,
      `${contract.productName} Tauri identifier must be ${contract.identifier}.`,
    );
    add(
      current.tauri.bundle?.targets === "all",
      `${contract.productName} must build all configured platform bundles.`,
    );
    add(
      current.tauri.bundle?.externalBin?.includes("binaries/showpilot-bridge"),
      `${contract.productName} must package the local Bridge engine.`,
    );
    add(
      current.releaseConfig.bundle?.createUpdaterArtifacts === true,
      `${contract.productName} CI release config must create signed updater artifacts.`,
    );
    add(
      JSON.stringify(current.tauri.plugins?.updater?.endpoints) ===
        JSON.stringify([contract.updaterEndpoint]),
      `${contract.productName} updater endpoint must be ${contract.updaterEndpoint}.`,
    );
    add(
      updaterPublicKeyIsValid(current.tauri.plugins?.updater?.pubkey),
      `${contract.productName} must embed a valid minisign updater public key.`,
    );

    const workflowFragments = [
      `- "${contract.tagPrefix}*"`,
      `projectPath: ${contract.projectPath}`,
      `tagName: ${contract.tagPrefix}__VERSION__`,
      "--config ci-release.conf.json",
      "uploadUpdaterJson: false",
      "releaseDraft: true",
      "TAURI_SIGNING_PRIVATE_KEY",
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
      "NO_STRIP: ${{ runner.os == 'Linux' && 'true' || '' }}",
      "APPLE_CERTIFICATE",
      "APPLE_CERTIFICATE_PASSWORD",
      "APPLE_ID",
      "APPLE_PASSWORD",
      "APPLE_TEAM_ID",
      "verify-macos-release.sh",
      "macos-14",
      "macos-15-intel",
      "windows-latest",
      "ubuntu-22.04",
      "WINDOWS_CERTIFICATE",
      "WINDOWS_CERTIFICATE_PASSWORD",
      "WINDOWS_TIMESTAMP_URL",
      "Import-PfxCertificate",
      "Get-AuthenticodeSignature",
      `pnpm native:verify --product ${product} --tag`,
    ];
    const missingWorkflowFragments = includesEvery(
      current.workflow,
      workflowFragments,
    );
    add(
      missingWorkflowFragments.length === 0,
      `${contract.productName} release workflow is missing: ${missingWorkflowFragments.join(", ")}.`,
    );

    for (const id of contract.landingIds) {
      add(
        snapshot.landingHtml.includes(`data-download-id="${id}"`),
        `Landing page is missing the ${id} download target.`,
      );
    }
    add(
      snapshot.landingWorker.includes(
        `url.pathname === "/updates/${product}/latest.json"`,
      ),
      `Landing Worker is missing the ${product} updater route.`,
    );
  }

  const desktop = snapshot.products.desktop.tauri;
  const bridge = snapshot.products.bridge.tauri;
  const workerFirstRoutes = snapshot.landingWrangler.assets?.run_worker_first;
  for (const route of ["/downloads", "/downloads/*", "/updates/*"]) {
    add(
      Array.isArray(workerFirstRoutes) && workerFirstRoutes.includes(route),
      `Landing Worker must run first for ${route}.`,
    );
  }
  add(
    desktop.identifier !== bridge.identifier,
    "Desktop and Bridge must have distinct application identifiers.",
  );
  add(
    desktop.plugins?.updater?.pubkey === bridge.plugins?.updater?.pubkey,
    "Desktop and Bridge must trust the same updater signing key.",
  );
  add(
    desktop.build?.frontendDist === "https://showpilot.tech",
    "Desktop production frontend must remain https://showpilot.tech.",
  );
  add(
    desktop.app?.windows?.[0]?.userAgent ===
      `ShowPilotDesktop/${snapshot.products.desktop.packageVersion}`,
    "Desktop user agent version must match the Desktop package version.",
  );

  const selectedProduct = options.product;
  const tagName = options.tagName;
  if (tagName !== undefined || selectedProduct !== undefined) {
    add(
      typeof selectedProduct === "string" &&
        Object.hasOwn(PRODUCT_CONTRACTS, selectedProduct),
      selectedProduct === undefined
        ? "A native product is required when a release tag is supplied."
        : `Unknown native product: ${selectedProduct}.`,
    );
    add(
      typeof tagName === "string" && tagName.length > 0,
      "A release tag is required when a product is selected.",
    );
    if (Object.hasOwn(PRODUCT_CONTRACTS, selectedProduct) && tagName) {
      const expected = `${PRODUCT_CONTRACTS[selectedProduct].tagPrefix}${snapshot.products[selectedProduct].packageVersion}`;
      add(
        tagName === expected,
        `${PRODUCT_CONTRACTS[selectedProduct].productName} tag must be exactly ${expected}; received ${tagName}.`,
      );
    }
  }

  return issues;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--product" && argument !== "--tag") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = arguments_[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    if (argument === "--product") options.product = value;
    else options.tagName = value;
  }
  return options;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const root = resolve(dirname(scriptPath), "..");
  try {
    const options = parseArguments(process.argv.slice(2));
    const issues = findNativeReleaseIssues(
      loadNativeReleaseSnapshot(root),
      options,
    );
    if (issues.length > 0) {
      console.error("Native release readiness failed:");
      for (const issue of issues) console.error(`- ${issue}`);
      process.exitCode = 1;
    } else {
      const scope = options.product
        ? `${PRODUCT_CONTRACTS[options.product].productName} ${options.tagName}`
        : "Desktop and Bridge";
      console.log(`Native release readiness passed for ${scope}.`);
    }
  } catch (error) {
    console.error(
      `Native release readiness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
