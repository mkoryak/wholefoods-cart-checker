const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Promise = require('bluebird');
const fs = require('fs');
const moment = require('moment');
const path = require('path');
const express = require('express');
const os = require('os');

const app = express();
const ifaces = os.networkInterfaces();

require('dotenv').config({path: path.resolve(process.cwd(), 'config.txt')});

// If these are null, you have to login manually. watch console.log
const AMAZON_PASSWORD = process.env.AMAZON_PASSWORD;
const AMAZON_EMAIL = process.env.AMAZON_EMAIL;
const WAT = (process.env.WAT || 'wholefoods').trim();
const TP_URLS = process.env.TP_URLS;
const TWILIO_CLIENT_ID = process.env.TWILIO_CLIENT_ID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const AUTO_ORDER_IF_POSSIBLE = process.env.AUTO_ORDER_IF_POSSIBLE == 'true';
const SMS_NOTIFY_LIST = process.env.SMS_NOTIFY_LIST.split(',');
const REFRESH_INTERVAL_SECONDS = parseInt(process.env.REFRESH_INTERVAL_SECONDS);
const DELAY_AFTER_FINDING_SECONDS = parseInt(
    process.env.DELAY_AFTER_FINDING_SECONDS); // Dont spam with sms after finding a window.

const urls = WAT === 'tp' ? TP_URLS.split(',').map(s => s.trim()) :
    ['https://www.amazon.com/gp/cart/view.html?ref_=nav_cart'];

// If false, will try to checkout amazon fresh cart.
const checkoutWholefoods = WAT === 'wholefoods';

// Good idea to keep on. Sometimes when you first login you get a capcha. This script will wait while you to
// solve it and login manually. 
const DEBUG_WITH_NON_HEADLESS = true;
const SERVER_PORT = 3000;

let localAddress = 'http://127.0.0.1:' + SERVER_PORT;

// We will find a better url later as we click around. 
let amazonUrl = 'https://www.amazon.com/gp/cart/view.html?ref_=nav_cart';

let availabilityWindows = [];
let lastPageLoad = moment();
let availabilityDate = 'Not available';

if (AUTO_ORDER_IF_POSSIBLE) {
  console.log('AUTO_ORDER_IF_POSSIBLE = true !!!!');
}

const LAST_ORDER_SCREENSHOT_PATH = './screenshots/last-order.png';
if (fs.existsSync(LAST_ORDER_SCREENSHOT_PATH)) {
  fs.unlinkSync(LAST_ORDER_SCREENSHOT_PATH);
}

puppeteer.use(StealthPlugin());

const client = require('twilio')(TWILIO_CLIENT_ID, TWILIO_AUTH_TOKEN);
let consequitiveErrorCount = 0;
const BADNESS = Symbol();

let page;
let browser;

let canMakeOrder = false;

async function smsMsg(body) {
  for (const cell of SMS_NOTIFY_LIST) {
    const msg = {
      body,
      from: TWILIO_FROM,
      to: cell.trim()
    };
    await client.messages.create(msg);
  }
}

function getLocalServerUrl(pathname = '/') {
  return localAddress + pathname;
}

async function testSms() {
  const screenshotPath = `/screenshots/test_sms_${moment().unix()}.png`;
  await page.screenshot({path: '.' + screenshotPath, fullPage: true});
  await smsMsg('testing 1,2,3: ' + getLocalServerUrl(screenshotPath));
}

async function sendSMS(offset, wtype, windows) {
  try {
    smsMsg(
        `Amazon has "${wtype}" delivery window ${offset} days from now!\n${windows}\n\nSee: ${getLocalServerUrl()}`);
  } catch (e) {
    console.log('error sending SMS.. ', e, msg);
  }
}

async function chooseDeliveryWindow(timeout = 40000) {
  console.log('clicking on a delivery window');
  await page.waitForSelector('.ufss-slot.ufss-available', {timeout});
  await page.click('.ufss-slot.ufss-available');
  await page.click('.a-button-input');
  try {
    await page.waitForSelector('#continue-top', {timeout});
    await page.click('#continue-top');
  } catch(e) {
    console.log('couldnt wait, but that might be ok still', e);
  }
}

async function makeOrder(notify = true, timeout = 30000) {
  console.log('trying to make order.. lets see if it works:)');
  await page.waitForSelector('#placeYourOrder', {timeout});
  await page.click('#placeYourOrder');
  const screenshotPath = `/screenshots/after-order-placed_${moment().unix()}.png`;

  await page.waitForSelector('.a-color-success'); // text about order in these 2 nodes
  // wait a while for all loading things to settle.
  await Promise.delay(1000 * 15);
  await page.screenshot({path: '.' + screenshotPath, fullPage: true});
  await page.screenshot({path: LAST_ORDER_SCREENSHOT_PATH, fullPage: true});
  canMakeOrder = false;

  if (notify) {
    await smsMsg(
        `Tried to place an order. See: ${getLocalServerUrl(screenshotPath)}`)
  }
}

async function check() {

  canMakeOrder = false;
  availabilityWindows = [];
  availabilityDate = "Not available";
  let foundAvailability = false;
  let foundNothing = true;

  lastPageLoad = moment();
  const texts = await page.$$eval('.ufss-date-select-toggle-text-availability',
      nodes => nodes.map(n => n.innerText));

  texts.forEach((text, i) => {
    foundNothing = false;
    console.log(`availability is:`, text, i);
    if (text.trim() !== 'Not available') {
      foundAvailability = {i, msg: text || 'Available'};
    }
  });

  if (foundAvailability) {
    let texts = '';
    try {
      texts = await page.$$eval(
          '.ufss-slot.ufss-available .ufss-slot-time-window-text',
          nodes => nodes.map(n => n.innerText));
      availabilityWindows = texts;
      availabilityDate = moment().add(parseInt(foundAvailability.i),
          'days').format("dddd, MMMM Do");
      texts = texts.join('\n');
    } catch (e) {
      console.log('something bad when getting available times! ', e);
    }
    await page.screenshot({path: './screenshots/found-window-'+moment().utc()+'.png'});
    console.log('sending SMS at ', moment().toISOString());

    try {
      await chooseDeliveryWindow();
      canMakeOrder = true;
      sendSMS(foundAvailability.i, foundAvailability.msg, texts);

      if (AUTO_ORDER_IF_POSSIBLE) {
        await makeOrder();
      }
    } catch (e) {
      console.log('error choose delivery window/ordering: ', e);
    }

    console.log(
        `Found delivery windows, waiting ${DELAY_AFTER_FINDING_SECONDS} seconds to check again`);
    await Promise.delay(1000 * DELAY_AFTER_FINDING_SECONDS); // Wait before doing this again.
  } else {
    console.log(`Looking again in ${REFRESH_INTERVAL_SECONDS} seconds`);
    await Promise.delay(1000 * REFRESH_INTERVAL_SECONDS); // check again in X minutes.
  }

  const cookies = await page.cookies();
  fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));

  if (!foundNothing) {
    await page.reload({
      waitUntil: "domcontentloaded"
    });
  }
}

async function evalButtonText(el) {
  return el.evaluate((el_) => {
    if (el_.classList.contains("a-button-input")) {
      return el_.parentNode.querySelector('.a-button-text').innerText.trim();
    } else {
      return el_.innerText.trim();
    }
  });
}

async function farmTP() {
  lastPageLoad = moment();
  const tpTitle = await page.title();
  const tryIt = async () => {
    await page.waitForSelector('#turbo-checkout-pyo-button', {timeout: 60000});
    await page.click('#turbo-checkout-pyo-button');
    await page.screenshot({path: './screenshots-ordering-tp-2_'+moment().utc()+'.png', fullPage: true});
    await page.screenshot({path: LAST_ORDER_SCREENSHOT_PATH, fullPage: true});
    await smsMsg('I just bought some TP! ' + getLocalServerUrl('/order-placed/'));
    await makeOrder();
    await Promise.delay(1000 * 60 * 60 * 24);
  };
  try {
    await page.waitForSelector('#buy-now-button');
    await page.click('#buy-now-button');
    await page.screenshot({path: './screenshots-ordering-tp-1_'+moment().utc()+'.png', fullPage: true});
    try {
      await tryIt();
    } catch(e) {
      console.log('badness when ordering TP, but will retry', e);
      try {
        await tryIt();
      }  catch(e) {
        console.log('ordering TP is not happening :p', e);
      }
    }
    await Promise.delay(1000 * 60 * 60 * 1);
  } catch (e) {
    //console.log('error in outer try/catch in tp ordering:', e);
    const title = await page.title();
    if (title !== tpTitle) {
      console.log('got redirected somewhere! TP was probably out of stock!');
      return;
    }
    await page.waitForSelector('#availability');
    const makeSure = await page.$('#availability');
    const text = await makeSure.evaluate((node) => {
      return node.innerText;
    });
    if (text.match(/unavailable/i) || text.match(/available from these sellers/i) || text.match(/in stock on/i)) {
      console.log(
          `NO TP FOR YOU! waiting ${REFRESH_INTERVAL_SECONDS} seconds`);
      await Promise.delay(1000 * REFRESH_INTERVAL_SECONDS); // Wait before doing this again.
    } else {
      console.log('something went wrong with TP ordering, unexpected text:', text);
      const title = await page.title();
      if (title !== tpTitle) {
        console.log('got redirected somewhere! TP was probably out of stock!');
        return;
      }
      await Promise.delay(1000 * 60 * 60 * 24);
    }
    if(urls.length === 1) {
      await page.reload({
        waitUntil: "domcontentloaded"
      });
    }
  }
}

async function dealWithShit() {
  await Promise.delay(1000 * 3);
  lastPageLoad = moment();
  try {
    const title = await page.title();
    console.log('Process page:', title);
    if (title === 'Substitution preferences' || title
        === "Before you checkout") {
      if (title === 'Substitution preferences') {
        amazonUrl = page.url();
      }
      try {
        await page.waitForSelector('.a-button-input');
        await page.click('.a-button-input');
      } catch (e) {
      }
    } else if (title === 'Amazon.com Thanks You') {
      console.log('looks like we just placed an order, sleeping for 24 hours.');
      await Promise.delay(1000 * 60 * 60 * 24);
    } else if (title === "Place Your Order - Amazon.com Checkout"
        && AUTO_ORDER_IF_POSSIBLE) {
      await makeOrder();
    } else if (title === "Amazon.com Shopping Cart") {

      try {
        await page.waitForSelector('.a-button-input', {timeout: 6000});
        const buttons = await page.$$('.a-button-input');
        let wholefoodsIndex = -1;
        let freshIndex = -1;
        console.log('You have these carts:');
        await Promise.all(buttons.map((button, i) => {
          return evalButtonText(button).then((text) => {
            if (text.match(/whole foods/i)) {
              wholefoodsIndex = i;
            }
            if (text.match(/fresh/i)) {
              freshIndex = i;
            }
            console.log(`#${i}: ${text}`);
          })
        }));
        const index = checkoutWholefoods ? wholefoodsIndex : freshIndex;
        if (index === -1) {
          console.log(
              'Cannot checkout a cart you dont have! Exiting');
          process.exit(-1);
        }
        console.log(`>>> Monitoring ${checkoutWholefoods ? 'whole foods'
            : 'amazon fresh'} cart at index: ${index}`);
        await buttons[index].click();

        await page.waitForSelector('a[name="proceedToCheckout"]');
        await page.click('a[name="proceedToCheckout"]');
      } catch (e) {
        console.log('looks like we are not logged in...', e);
      }
    } else if (title === "Your Amazon.com") {
      console.log('Saving your cookies to ./cookies.json');
      const cookies = await page.cookies();
      fs.writeFileSync('./cookies.json', JSON.stringify(cookies, null, 2));

      await page.goto(urls[0], {
        waitUntil: "domcontentloaded"
      });

    } else if (title === "Amazon Password Assistance") {
      console.log(
          'you are on Amazon Password Assistance page! Lets get out of here!');
      await page.goto(urls[0],
          {
            waitUntil: "domcontentloaded"
          });
    } else if (title === "Reserve a Time Slot - Amazon.com Checkout") {
      // wait for a really long time in case the capcha comes up during login and i can solve it.
      await page.waitForSelector('.ufss-overview-container',
          {timeout: 1000 * 60 * 5});
      await check(page, browser);
    } else if (title === "Amazon Sign-In") {
      try {
        await page.waitForSelector('#continue', {timeout: 1000});
        if (AMAZON_EMAIL) {
          await page.type('#ap_email', AMAZON_EMAIL);
          await page.click('input#continue');
        } else {
          console.log(
              "!!! Login to the site and wait for script, you have 1 minute.");
          await page.focus('#ap_email');
          await Promise.delay(1000 * 60 * 1);
        }
      } catch (e) {
        try {
          await page.waitForSelector('#image-captcha-section', {timeout: 1000});
          console.log('SOLVE THIS CAPCHA! in 1 minute and click signin');
          await Promise.delay(1000 * 60 * 1);
        } catch (e) {
          await page.waitForSelector('#ap_password');
          await page.click('input[name="rememberMe"]');
          if (AMAZON_PASSWORD) {
            await page.type('#ap_password', AMAZON_PASSWORD);
            await page.click('#signInSubmit');
          } else {
            console.log(
                "!!! Login to the site and wait for script, you have 1 minute.");
            await page.focus('#ap_password');
            await Promise.delay(1000 * 60 * 1);
          }
        }
      }

    } else if (title === "Preparing your order") {
      await Promise.delay(1000 * 3); // nothing happens on this page... 
    } else {
      if (title.startsWith('Amazon.com: ') && title.match(/toilet paper/i)) {
        console.log('We are farming TP today!');
        await farmTP();
      } else {

        console.log('I dont know what to do on this page, somewhere good..');
        await page.goto(urls[0], {
          waitUntil: "domcontentloaded"
        });
      }
    }
    consequitiveErrorCount = 0;
  } catch (e) {
    consequitiveErrorCount++;
    console.log('error while processing page:\n', e);
    if (consequitiveErrorCount > 40 || (e+"").match(/Session closed/ig)) {
      consequitiveErrorCount = 0;
      return BADNESS;
    }
  }
}

async function setup() {
  console.log(`\nStarting at ${moment().toISOString()}`);
  browser = await puppeteer.launch({headless: !DEBUG_WITH_NON_HEADLESS});

  page = await browser.newPage();

  if (fs.existsSync('./cookies.json')) {
    const cookies = JSON.parse(fs.readFileSync('./cookies.json'));
    console.log('We found some cookies, eating them!  YUM');
    await page.setCookie(...cookies);
  }

  await page.setViewport({
    width: 1280,
    height: 1050
  });

  await page.goto(urls[0], {
    waitUntil: "domcontentloaded"
  });

  const userEl = await page.$('#nav-link-accountList .nav-line-1');
  const text = await userEl.evaluate((el) => el.innerText.trim());
  if (text === "Hello, Sign in") {
    console.log('you need to login!');
    await page.goto(
        'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fs%3Fk%3Dlogin%26ref_%3Dnav_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&');
  }

  let running = true;
  let i = 0;
  do {
    let thing = await dealWithShit(page, browser);

    i++;
    if (urls.length > 1) {
      try {
        await page.goto(urls[i % urls.length], {
          waitUntil: "domcontentloaded"
        });
      } catch(e) {
        thing = BADNESS;
      }
    }
    if (thing === BADNESS) {
      running = false;
      await browser.close();
      console.log('I saw some errors, starting everything over!');
      await Promise.delay(1000 * 60 * 3);
      setImmediate(() => {
        setup();
      })
    }
  } while (running);
}

try {
  setup();
} catch (e) {
  console.log('BADNESS HAPPEN:', e);
}

function renderError(res, e) {
  res.setHeader('content-type', 'text/html');
  res.send(`<html><head><title>Someone set us up the bomb!</title></head>
    <body><a href="/">Go back to that other useless page</a><br/>
    <h1>You have found the error page for the error page!</h1><pre>${e.stack}</pre></body></html>`);
}

app.get('/', async (req, res) => {
  const encodedImg = await page.screenshot(
      {encoding: 'base64', fullPage: true});
  res.setHeader('content-type', 'text/html');
  availabilityWindows = [availabilityWindows[0]];
  const orderLinks = availabilityWindows.map((text, i) => {
    return `<a href="/order" style="font-size: 34px; margin-bottom: 10px; padding: 0 10px; color: green; display: block;">Place this order at [${text}] on ${availabilityDate}<a>`
  });
  res.send(`<html><head><title>Using the blockchain for wholefoods deliveries!</title></head>
    <body>
    <h1 style="display:${canMakeOrder ? 'block' : 'none'};">${orderLinks} (wait up to a 1 minute after clicking)</h1>
    <h1><a href="/test-sms" style="font-size: 14px; margin-bottom: 10px;">Send a test SMS<a></h1>
    <h1><a href="${amazonUrl}" style="font-size: 24px; margin-bottom: 10px;">Amazon Cart</a></h1>
    <br/>
    <b>Screenshot</b> of current page loaded ${moment().diff(lastPageLoad,
      'seconds')} seconds ago:<br/>
    <img src="data:image/png;base64, ${encodedImg}"></body></html>`);
});
app.get('/test-sms', async (req, res) => {
  try {
    await testSms();
    res.send('it worked!');
  } catch (e) {
    renderError(res, e);
  }
});

app.get('/order-placed', async (req, res) => {
  res.setHeader('content-type', 'text/html');
  res.send(`<html><body><h1>I think it worked, go confirm at <a href="https://amazon.com">amazon.com</a></h1>
    <br/><br/>
    I see this:
    <br/>
    <img src="/screenshots/last-order.png">
    </body></html>`);
});

app.get('/order', async (req, res) => {
  try {
    await makeOrder(/*notify= */ false);
    res.redirect('/order-placed');
  } catch (e) {
    renderError(res, e);
  }
});
app.use('/screenshots', express.static('screenshots'));

Object.keys(ifaces).forEach(function (ifname) {
  ifaces[ifname].forEach(function (iface) {
    if ('IPv4' !== iface.family || iface.internal !== false) {
      return;
    }
    localAddress = `http://${iface.address}:${SERVER_PORT}`;
    console.log(`Server started on ${localAddress}`);
  });
});
console.log('-------------------------------\n\n');

app.listen(SERVER_PORT);

