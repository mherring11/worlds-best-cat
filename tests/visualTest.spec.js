const { test } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const sharp = require("sharp");
const config = require("../config.js");

let pixelmatch;
let chalk;

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

// Compare two screenshots and return similarity percentage
async function compareScreenshots(baselinePath, currentPath, diffPath) {
  await resizeImage(baselinePath, 1280, 800);
  await resizeImage(currentPath, 1280, 800);

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(currentPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    console.log(
      chalk.red(`Size mismatch for ${baselinePath} and ${currentPath}`)
    );
    return "Size mismatch";
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const mismatchedPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    { threshold: 0.1 }
  );
  fs.writeFileSync(diffPath, PNG.sync.write(diff));

  const totalPixels = img1.width * img1.height;
  const matchedPixels = totalPixels - mismatchedPixels;
  return (matchedPixels / totalPixels) * 100;
}

// Forcefully capture screenshot for a given URL
async function captureScreenshot(page, url, screenshotPath) {
  try {
    console.log(chalk.blue(`Navigating to: ${url}`));

    const navigationPromise = page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    const timeoutPromise = new Promise(
      (resolve) =>
        setTimeout(() => {
          console.log(
            chalk.red(`Timeout detected on ${url}. Forcing screenshot.`)
          );
          resolve();
        }, 10000) // Timeout after 10 seconds
    );

    await Promise.race([navigationPromise, timeoutPromise]);

    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Screenshot captured: ${screenshotPath}`));
  } catch (error) {
    console.error(
      chalk.red(`Failed to capture screenshot for ${url}: ${error.message}`)
    );
    ensureDirectoryExistence(screenshotPath);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(chalk.green(`Forced screenshot captured: ${screenshotPath}`));
  }
}

// Generate HTML report
function generateHtmlReport(results, deviceName) {
  const reportPath = `visual_comparison_report_${deviceName}.html`;
  const now = new Date().toLocaleString();
  const environments = `
    <a href="${config.staging.baseUrl}" target="_blank">Staging: ${config.staging.baseUrl}</a>,
    <a href="${config.prod.baseUrl}" target="_blank">Prod: ${config.prod.baseUrl}</a>
  `;

  let htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Visual Comparison Report - ${deviceName}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.5; margin: 20px; }
        h1, h2 { text-align: center; }
        .summary { text-align: center; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }
        th { background-color: #f2f2f2; }
        .pass { color: green; font-weight: bold; }
        .fail { color: red; font-weight: bold; }
        .error { color: orange; font-weight: bold; }
        img { max-width: 150px; cursor: pointer; }
        #modal {
          display: none;
          position: fixed;
          z-index: 1000;
          left: 0;
          top: 0;
          width: 100%;
          height: 100%;
          overflow: auto;
          background-color: rgba(0, 0, 0, 0.8);
        }
        #modal img {
          display: block;
          margin: 50px auto;
          max-width: 80%;
        }
      </style>
    </head>
    <body>
      <h1>Visual Comparison Report</h1>
      <h2>Device: ${deviceName}</h2>
      <div class="summary">
        <p>Total Pages Tested: ${results.length}</p>
        <p>Passed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage >= 95
          ).length
        }</p>
        <p>Failed: ${
          results.filter(
            (r) =>
              typeof r.similarityPercentage === "number" &&
              r.similarityPercentage < 95
          ).length
        }</p>
        <p>Errors: ${
          results.filter((r) => r.similarityPercentage === "Error").length
        }</p>
        <p>Last Run: ${now}</p>
        <p>Environments Tested: ${environments}</p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Page</th>
            <th>Similarity</th>
            <th>Status</th>
            <th>Thumbnail</th>
          </tr>
        </thead>
        <tbody>
  `;

  results.forEach((result) => {
    const diffThumbnailPath = `screenshots/${deviceName}/diff/${result.pagePath.replace(
      /\//g,
      "_"
    )}.png`;

    const stagingUrl = `${config.staging.baseUrl}${result.pagePath}`;
    const prodUrl = `${config.prod.baseUrl}${result.pagePath}`;

    const statusClass =
      typeof result.similarityPercentage === "number" &&
      result.similarityPercentage >= 95
        ? "pass"
        : "fail";

    htmlContent += `
      <tr>
        <td>
          <a href="${stagingUrl}" target="_blank">Staging</a> |
          <a href="${prodUrl}" target="_blank">Prod</a>
        </td>
        <td>${
          typeof result.similarityPercentage === "number"
            ? result.similarityPercentage.toFixed(2) + "%"
            : result.similarityPercentage
        }</td>
        <td class="${statusClass}">${
      result.similarityPercentage === "Error"
        ? "Error"
        : result.similarityPercentage >= 95
        ? "Pass"
        : "Fail"
    }</td>
        <td>${
          fs.existsSync(diffThumbnailPath)
            ? `<a href="${diffThumbnailPath}" target="_blank"><img src="${diffThumbnailPath}" /></a>`
            : "N/A"
        }</td>
      </tr>
    `;
  });

  htmlContent += `
        </tbody>
      </table>
      <div id="modal" onclick="closeModal()">
        <img id="modal-image" src="" />
      </div>
      <script>
        function openModal(src) {
          const modal = document.getElementById('modal');
          const modalImg = document.getElementById('modal-image');
          modalImg.src = src;
          modal.style.display = 'block';
        }
        function closeModal() {
          document.getElementById('modal').style.display = 'none';
        }
      </script>
    </body>
    </html>
  `;

  fs.writeFileSync(reportPath, htmlContent);
  console.log(chalk.green(`HTML report generated: ${reportPath}`));
}

// Main Test Suite
test.describe("Visual Comparison Tests", () => {
  test("Compare staging and prod screenshots and generate HTML report", async ({
    browser,
  }) => {
    const results = [];
    const deviceName = "Desktop";

    console.log(chalk.blue("Running tests..."));

    const baseDir = `screenshots/${deviceName}`;
    ["staging", "prod", "diff"].forEach((dir) => {
      if (!fs.existsSync(path.join(baseDir, dir))) {
        fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
      }
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

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

      try {
        await captureScreenshot(page, stagingUrl, stagingScreenshotPath);
        await captureScreenshot(page, prodUrl, prodScreenshotPath);

        const similarity = await compareScreenshots(
          stagingScreenshotPath,
          prodScreenshotPath,
          diffScreenshotPath
        );

        results.push({ pagePath, similarityPercentage: similarity });
      } catch (error) {
        results.push({
          pagePath,
          similarityPercentage: "Error",
          error: error.message,
        });
      }
    }

    generateHtmlReport(results, deviceName);
    await context.close();
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
