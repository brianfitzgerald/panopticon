import { APIGatewayProxyHandler } from "aws-lambda";
import * as puppeteer from "puppeteer-core";
import * as chromium from "chrome-aws-lambda";
import * as AWS from "aws-sdk";
const compare = require("resemblejs").compare;
import { WebClient, IncomingWebhook } from "@slack/client";
import { IncomingWebhookSendError } from "@slack/client/dist/IncomingWebhook";

type ResembleOutput = {
  isSameDimensions: boolean;
  dimensionDifference: { width: number; height: number };
  rawMisMatchPercentage: number;
  misMatchPercentage: string;
  diffBounds: { top: number; left: number; bottom: number; right: number };
  analysisTime: number;
  getImageDataUrl: [Function];
};

type RouteOutput = {
  routePath: string;
  passed: boolean;
  successPercent: number;
  failureThreshold: number;
  resembleOutput: ResembleOutput;
  activeConfig: SiteConfig;
};

type PanopticonConfig = {
  site: SiteConfig;
  configs?: SiteConfig[];
};

type Route =
  | string
  | {
      route: string;
      failureThresholdPercentage?: number;
    };

type SiteConfig = {
  baseURL: string;
  failureThresholdPercentage?: number;
  routes: Route[];
};

const exampleConfig: PanopticonConfig = {
  site: {
    baseURL: "https://www.mycarfax.com",
    failureThresholdPercentage: 60,
    routes: ["", "/help/faq"]
  }
};

type Screen = AWS.S3.Body | Buffer;

// wrap the compare call because SOME LIBRARIES don't support promises for their callbacks
async function compareScreens(
  screen1: Screen,
  screen2: Screen,
  params: Object
): Promise<ResembleOutput> {
  return new Promise((resolve, reject) => {
    compare(
      screen1,
      screen2,
      {
        returnEarlyThreshold: 50
      },
      (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data as ResembleOutput);
        }
      }
    );
  });
}

// format the S3 picture key
const getPicturePath = (baseUrl: string, route: string): string => {
  const url = `${baseUrl}${route}`;
  let path = url.split("//")[1];
  path = path.split("/").join(":");
  return path;
};

// take a screenshot for each page
// compare against the previous day page
// return stats for each page
export const daily: APIGatewayProxyHandler = async (event, context) => {
  if (process.env.IS_OFFLINE) {
    var credentials = new AWS.SharedIniFileCredentials({
      profile: "cxd-development"
    });
    AWS.config.credentials = credentials;
  }

  const s3 = new AWS.S3();

  let browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath,
    headless: chromium.headless
  });

  const page = await browser.newPage();

  const bucketName = "panopticon-photos";

  // TODO: add support for parsing multiple configs
  const activeConfig = exampleConfig.site;

  const allResults: RouteOutput[] = [];

  await Promise.all(
    activeConfig.routes.map(async route => {
      const routePath = typeof route == "string" ? route : route.route;
      const path = getPicturePath(activeConfig.baseURL, routePath);
      const url = `${activeConfig.baseURL}${route}`;
      await page.goto(url);
      const screenshot = await page.screenshot({
        fullPage: true
      });
      const currentDayString = new Date().toISOString().split("T")[0];
      const currentDayPath = `${path}/${currentDayString}.png`;

      const previousDay = new Date();
      previousDay.setDate(previousDay.getDate() - 1);
      const previousDayString = previousDay.toISOString().split("T")[0];

      const previousDayPath = `${path}/${previousDayString}.png`;

      try {
        await s3
          .putObject({
            Bucket: bucketName,
            Key: currentDayPath,
            Body: screenshot
          })
          .promise();

        const previousDayScreenshot = await s3
          .getObject({
            Bucket: bucketName,
            Key: previousDayPath
          })
          .promise();

        if (!previousDayScreenshot.Body) {
          return;
        }

        const resembleOutput = await compareScreens(
          previousDayScreenshot.Body,
          screenshot,
          {
            returnEarlyThreshold: 50
          }
        );

        let passed = true;
        let failureThreshold = 0;

        const successPercent =
          100 - parseInt(resembleOutput.misMatchPercentage);

        if (
          activeConfig.failureThresholdPercentage &&
          successPercent < activeConfig.failureThresholdPercentage
        ) {
          passed = false;
          failureThreshold = activeConfig.failureThresholdPercentage;
        }

        if (
          typeof route !== "string" &&
          route.failureThresholdPercentage &&
          successPercent < route.failureThresholdPercentage
        ) {
          passed = false;
          failureThreshold = route.failureThresholdPercentage;
        }

        allResults.push({
          successPercent,
          resembleOutput,
          passed,
          failureThreshold,
          routePath,
          activeConfig
        });
      } catch (e) {
        console.error(e);
      }
    })
  );

  await browser.close();

  let message = "Results:\n";
  const successful = allResults.filter(r => r.passed).length;
  message += `${successful} / ${allResults.length} Passed\n`;
  allResults
    .filter(r => !r.passed)
    .forEach(r => {
      message += `${r.activeConfig.baseURL}${r.routePath} Failed:\n`;
      message += `${r.successPercent}% similar to yesterday, threshold is ${
        r.failureThreshold
      }%\n`;
    });

  console.log(message);

  const slackToken = "";

  const web = new WebClient(slackToken);

  const webhookURL =
    "https://hooks.slack.com/services/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";
  const webhook = new IncomingWebhook(webhookURL, {
    username: "Panopticon Bot",
    channel: "mycarfax-alerts",
    icon_emoji: ":brian_why:"
  });

  try {
    const response = await webhook.send(message);
    console.log(response.text);
  } catch (e) {
    const a = e as IncomingWebhookSendError;
    console.error(a.code);
    console.error(a.message);
    console.error(a.errno);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message,
      input: event
    })
  };
};
