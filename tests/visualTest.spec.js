const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

// Staging authentication credentials
const STAGING_USERNAME = "wbclstg";
const STAGING_PASSWORD = "chl_wbclstg";

// Dynamically load `pixelmatch` and `chalk`
(async () => {
  pixelmatch = (await import("pixelmatch")).default;
  chalk = (await import("chalk")).default;
})();

// Helper Functions

// Ensure directory exists
function ensureDirectoryExistence(filePath) {
  const dirname = path.dirname(filePath);
  if (!fs.existsSync(dirname)) {
    fs.mkdirSync(dirname, { recursive: true });
  }
}

// Convert image to Base64
function imageToBase64(imagePath) {
  if (fs.existsSync(imagePath)) {
    const imageData = fs.readFileSync(imagePath).toString("base64");
    const ext = path.extname(imagePath).replace(".", ""); // Get file extension (e.g., png)
    return `data:image/${ext};base64,${imageData}`;
  }
  return null; // Return null if image is missing
}

// Resize images to match specified dimensions (1280x800)
async function resizeImage(imagePath, width, height) {
  const buffer = fs.readFileSync(imagePath);
  const resizedBuffer = await sharp(buffer)
    .resize(width, height, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toBuffer();
  fs.writeFileSync(imagePath, resizedBuffer);
}

// Scroll to the bottom of the page and back to the top
async function scrollPage(page) {
  console.log(chalk.yellow("Force scrolling to the bottom of the page..."));

  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      let totalHeight = 0;
      const distance = window.innerHeight;
      const maxAttempts = 10; // Prevent infinite loop
      let attempt = 0;

      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        attempt++;

        if (totalHeight >= document.body.scrollHeight - window.innerHeight || attempt >= maxAttempts) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });

  console.log(chalk.yellow("Scrolling back to the top..."));
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log(chalk.yellow("Waiting 3 seconds for lazy-loaded elements..."));
  await page.waitForTimeout(3000);
  await page.waitForLoadState("networkidle");
}


// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  if (!fs.existsSync(baselinePath) || !fs.existsSync(currentPath)) {
    console.log(
      chalk.red(`Missing file(s): ${baselinePath} or ${currentPath}`)
    );
    return "Error";
  }

  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath)); // Staging
  const img2 = PNG.sync.read(fs.readFileSync(currentPath)); // Prod

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });

  pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    threshold: 0.1,
    diffColor: [0, 0, 255], // Blue for Prod Differences
    diffColorAlt: [255, 165, 0], // Orange for Staging Differences
  });

  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    null,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );

  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Capture screenshot for a given URL with scrolling
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    try {
      await scrollPage(page);
    } catch (scrollError) {
      console.warn(chalk.red(`⚠️ Scroll failed for ${url}: ${scrollError.message}. Taking screenshot anyway.`));
    }

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`✅ Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(chalk.red(`❌ Failed to capture screenshot for ${url}: ${error.message}`));
  }
}

// Generate HTML report with Base64 embedded images
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();

  // Count passed, failed, and errors
  const passed = results.filter(
    (r) => typeof r.similarityPercentage === "number" && r.similarityPercentage >= 95
  ).length;
  const failed = results.filter(
    (r) => typeof r.similarityPercentage === "number" && r.similarityPercentage < 95
  ).length;
  const errors = results.filter(
    (r) => r.similarityPercentage === "Error"
  ).length;

  // **SORT RESULTS: Failed first, then errors, then passed**
  results.sort((a, b) => {
    if (a.similarityPercentage === "Error") return -1;
    if (b.similarityPercentage === "Error") return 1;
    if (
      typeof a.similarityPercentage === "number" &&
      typeof b.similarityPercentage === "number"
    ) {
      return a.similarityPercentage - b.similarityPercentage; // Lower similarity first
    }
    return 0;
  });

  let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin-bottom: 20px; }
        .summary p { font-size: 16px; }
        .summary span { font-weight: bold; }
        .summary .passed { color: green; }
        .summary .failed { color: red; }
        .summary .errors { color: orange; }
        .staging { color: orange; font-weight: bold; }
        .prod { color: blue; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; vertical-align: middle; }
        th { background-color: #f2f2f2; }
        .image-container { display: flex; justify-content: center; align-items: center; gap: 15px; }
        .image-wrapper { display: flex; flex-direction: column; align-items: center; }
        .image-container img { width: 350px; cursor: pointer; border: 1px solid #ddd; }
        .image-label { font-size: 14px; font-weight: bold; margin-top: 5px; text-align: center; }
        .status-pass { color: green; font-weight: bold; }
        .status-fail { color: red; font-weight: bold; }
        .status-error { color: orange; font-weight: bold; }
        .criteria { font-size: 14px; text-align: center; margin-top: 10px; font-weight: bold; }
        .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.8); }
        .modal img { display: block; max-width: 90%; max-height: 90%; margin: auto; }
        .modal-close { position: absolute; top: 20px; right: 30px; font-size: 30px; color: white; cursor: pointer; }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p><span class="staging">Staging:</span> ${config.staging.baseUrl} | <span class="prod">Prod:</span> ${config.prod.baseUrl}</p>
        <p>Total Pages Tested: <span>${results.length}</span></p>
        <p>Passed: <span class="passed">${passed}</span> | Failed: <span class="failed">${failed}</span> | Errors: <span class="errors">${errors}</span></p>
        <p>Last Run: ${now}</p>
        <a href="${reportPath}" download>Download Report</a>
      </div>
      <p class="criteria">✅ Success Criteria: A similarity score of 95% or higher is considered a pass.</p>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Images</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const sanitizedPath = result.pagePath.replace(/\//g, "_");
    const stagingBase64 = imageToBase64(
      `screenshots/${deviceName}/staging/${sanitizedPath}.png`
    );
    const prodBase64 = imageToBase64(
      `screenshots/${deviceName}/prod/${sanitizedPath}.png`
    );
    const diffBase64 = imageToBase64(
      `screenshots/${deviceName}/diff/${sanitizedPath}.png`
    );

    let statusClass = "status-error";
    let statusText = "Error";

    if (typeof result.similarityPercentage === "number") {
      if (result.similarityPercentage >= 97) {
        statusClass = "status-pass";
        statusText = "Pass";
      } else {
        statusClass = "status-fail";
        statusText = "Fail";
      }
    }

    htmlContent += `
    <tr>
  <td>
    <a href="${config.prod.baseUrl}${result.pagePath}" target="_blank" class="prod-url">
      <strong>${config.prod.baseUrl}${result.pagePath}</strong>
    </a><br>
    <a href="${config.staging.baseUrl}${result.pagePath}" target="_blank" class="staging">Staging</a> | 
    <a href="${config.prod.baseUrl}${result.pagePath}" target="_blank" class="prod">Prod</a>
  </td>
  <td>${typeof result.similarityPercentage === "number"
      ? result.similarityPercentage.toFixed(2) + "%"
      : "Error"}
  </td>
  <td class="${statusClass}">${statusText}</td>
  <td>
    <div class="image-container">
      ${stagingBase64 ? `<div class="image-wrapper">
        <img src="${stagingBase64}" onclick="openModal('${stagingBase64}')" alt="Staging">
        <div class="image-label">Staging</div>
      </div>` : "N/A"}
      ${prodBase64 ? `<div class="image-wrapper">
        <img src="${prodBase64}" onclick="openModal('${prodBase64}')" alt="Prod">
        <div class="image-label">Prod</div>
      </div>` : "N/A"}
      ${diffBase64 ? `<div class="image-wrapper">
        <img src="${diffBase64}" onclick="openModal('${diffBase64}')" alt="Diff">
        <div class="image-label">Diff</div>
      </div>` : "N/A"}
    </div>
  </td>
</tr>
  `;
  });

  htmlContent += `
        </tbody>
      </table>

      <div id="modal" class="modal">
        <span class="modal-close" onclick="closeModal()">&times;</span>
        <img id="modal-image">
      </div>

      <script>
        function openModal(imageSrc) { 
          document.getElementById("modal-image").src = imageSrc; 
          document.getElementById("modal").style.display = "block"; 
        }
        function closeModal() { 
          document.getElementById("modal").style.display = "none"; 
        }
      </script>

    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Capture screenshot for a given URL with scrolling and an idle timeout
async function captureScreenshotWithIdleTimeout(page, url, screenshotPath, nextUrl) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    try {
      await scrollPage(page);
    } catch (scrollError) {
      console.warn(chalk.red(`⚠️ Scroll failed for ${url}: ${scrollError.message}. Taking screenshot anyway.`));
    }

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`✅ Screenshot captured: ${screenshotPath}`));

    console.log(chalk.yellow("Idle timeout started... Waiting for 10 seconds before navigating to next URL."));
    await page.waitForTimeout(5000); // 10 seconds idle time

    if (nextUrl) {
      console.log(chalk.blue(`⏭ Navigating to next URL: ${nextUrl}`));
      await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
    }

  } catch (error) {
    console.error(chalk.red(`❌ Failed to capture screenshot for ${url}: ${error.message}`));
  }
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test.setTimeout(14400000);
  test("Compare staging and prod screenshots and generate HTML report", async ({ browser }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    // Create browser contexts for staging (with authentication) and production
    const stagingContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      httpCredentials: {
        username: STAGING_USERNAME,
        password: STAGING_PASSWORD,
      },
    });
    const prodContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    const stagingPage = await stagingContext.newPage();
    const prodPage = await prodContext.newPage();

    for (const pagePath of config.staging.urls) {
      const stagingUrl = `${config.staging.baseUrl}${pagePath}`;
      const prodUrl = `${config.prod.baseUrl}${pagePath}`;
      const stagingScreenshotPath = path.join(
        baseDir,
        "staging",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const prodScreenshotPath = path.join(
        baseDir,
        "prod",
        `${pagePath.replace(/\//g, "_")}.png`
      );
      const diffScreenshotPath = path.join(
        baseDir,
        "diff",
        `${pagePath.replace(/\//g, "_")}.png`
      );

      console.log(chalk.yellow(`🔄 Testing page: ${pagePath}`));

      try {
        await captureScreenshot(stagingPage, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(prodPage, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
        console.log(chalk.green(`✔ Successfully compared: ${pagePath} (${similarity.toFixed(2)}%)`));
      } catch (error) {
        console.log(chalk.red(`✖ Error testing ${pagePath}: ${error.message}`));
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    // Generate HTML report
    generateHtmlReport(results, deviceName);

    console.log(chalk.blue("✔ Test run complete."));
    await stagingContext.close();
    await prodContext.close();
  });

  test.describe("Product Carousel Image Verification", () => {
    const urls = [
      "https://www.worldsbestcatlitter.com/",
      "https://www.worldsbestcatlitter.com/natural-cat-litter/",
      "https://www.worldsbestcatlitter.com/poop-fighter-litter/",
      "https://www.worldsbestcatlitter.com/comfort-care-litter/",
      "https://www.worldsbestcatlitter.com/scoopable-multiple-cat-clumping-litter/",
      "https://www.worldsbestcatlitter.com/lavender-scent-litter/",
      "https://www.worldsbestcatlitter.com/lotus-blossom-scent-litter/",
      "https://www.worldsbestcatlitter.com/low-tracking-dust-control-litter/",
      "https://www.worldsbestcatlitter.com/explore-boosters/",
      "https://www.worldsbestcatlitter.com/our-difference/",
      "https://www.worldsbestcatlitter.com/worlds-best-cat-litter-reviews/",
    ];

    const carouselSelector = "#product-carousel";
    const imageSelector = `${carouselSelector} img`;

    test("Verify all images in product carousels across multiple pages", async ({
      page,
    }) => {
      console.log(chalk.bold("\nStarting Product Carousel Verification\n"));

      for (const url of urls) {
        console.log(chalk.bold(`\nTesting URL: ${url}`));
        let passed = true;

        try {
          console.log(chalk.blue(`Navigating to: ${url}`));
          await page.goto(url, { waitUntil: "networkidle" });

          console.log(chalk.blue("Scrolling to the first product carousel..."));
          const carousel = await page.locator(carouselSelector).first();
          await carousel.scrollIntoViewIfNeeded();

          console.log(chalk.blue("Waiting for carousel images to load..."));
          const images = await carousel.locator("img");

          const imageCount = await images.count();
          console.log(
            chalk.green(`Found ${imageCount} images in the carousel.`)
          );

          if (imageCount === 0) {
            console.log(
              chalk.red(`No images found in the carousel for ${url}.`)
            );
            passed = false;
            continue;
          }

          for (let i = 0; i < imageCount; i++) {
            const imageLocator = images.nth(i);
            const imageUrl = await imageLocator.getAttribute("src");
            const imageAlt = await imageLocator.getAttribute("alt");

            if (!imageUrl) {
              console.log(
                chalk.red(`Image ${i + 1} is missing the 'src' attribute.`)
              );
              passed = false;
            } else {
              console.log(
                chalk.green(`Image ${i + 1} 'src' verified: ${imageUrl}`)
              );
            }

            if (!imageAlt) {
              console.log(
                chalk.yellow(`Image ${i + 1} is missing the 'alt' attribute.`)
              );
            } else {
              console.log(
                chalk.green(`Image ${i + 1} 'alt' verified: ${imageAlt}`)
              );
            }
          }
        } catch (error) {
          console.log(
            chalk.red(`Error encountered on ${url}: ${error.message}`)
          );
          passed = false;
        }

        console.log(
          passed
            ? chalk.green(`✔ URL passed: ${url}`)
            : chalk.red(`✘ URL failed: ${url}`)
        );
      }

      console.log(chalk.bold("\nProduct Carousel Verification Complete\n"));
    });
  });
});
