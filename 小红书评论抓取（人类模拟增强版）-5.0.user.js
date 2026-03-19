// ==UserScript==
// @name         小红书评论抓取（人类模拟增强版）
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  抓取评论+子评论+图片，模拟真人操作
// @match        https://www.xiaohongshu.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /************* 工具 *************/
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => Math.random() * (b - a) + a;

  function txt(el) {
    return el ? el.innerText.trim() : "";
  }

  function getImages(root) {
    return Array.from(root.querySelectorAll(".comment-picture img"))
      .map(img => img.src);
  }

  function getScroller() {
    return (
      document.querySelector(".note-scroller") ||
      document.querySelector(".comments-container")?.parentElement ||
      document.querySelector(".comments-container") ||
      document.body
    );
  }

  /************* 模拟鼠标 *************/
  async function moveMouse(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new MouseEvent("mousemove", {
        clientX: x + rand(-10, 10),
        clientY: y + rand(-10, 10),
        bubbles: true
      }));
      await sleep(rand(30, 80));
    }
  }

  /***********************
   * 人类滚动
   ***********************/
  async function scrollToEnd(scroller) {

    console.log("开始滚动");

    for (let i = 0; i < 200; i++) {

      let delta = rand(400, 900);
      scroller.scrollTop += delta;

      await sleep(rand(800, 2000));

      if (Math.random() < 0.2) {
        scroller.scrollTop -= rand(100, 300);
        await sleep(rand(500, 1200));
      }

      if (Math.random() < 0.15) {
        console.log("发呆...");
        await sleep(rand(2000, 4000));
      }

      if (document.querySelector(".end-container")) {
        console.log("已到 THE END");
        break;
      }
    }
  }

  /***********************
   * 人类展开
   ***********************/
  async function expandAll() {

    console.log("展开回复");

    for (let i = 0; i < 100; i++) {

      let btns = Array.from(document.querySelectorAll("*"))
        .filter(el => (el.innerText || "").includes("展开"));

      if (!btns.length) break;

      for (let b of btns) {

        if (!document.contains(b)) continue;

        await moveMouse(b);
        await sleep(rand(200, 600));

        try { b.click(); } catch(e){}

        await sleep(rand(500, 1200));
      }

      await sleep(rand(1000, 1800));
    }
  }

  /***********************
   * 等待DOM稳定
   ***********************/
  async function waitStable(scroller) {

    let last = 0;
    let stable = 0;

    for (let i = 0; i < 20; i++) {

      let now = scroller.scrollHeight;

      if (now === last) {
        stable++;
      } else {
        stable = 0;
      }

      if (stable >= 3) {
        console.log("DOM稳定");
        return;
      }

      last = now;
      await sleep(500);
    }
  }

  /***********************
   * 解析（原逻辑完全保留）
   ***********************/
  function parseAll() {

    const blocks = document.querySelectorAll(".parent-comment");

    let items = [];

    blocks.forEach((block, i) => {

      const top = block.querySelector(".comment-item");

      let comment = {
        user: txt(top.querySelector(".name")),
        text: txt(top.querySelector(".content")),
        time: txt(top.querySelector(".date span")),
        location: txt(top.querySelector(".location")),
        images: getImages(top)
      };

      let replies = [];

      const container = block.querySelector(".reply-container");

      if (container) {
        const subs = container.querySelectorAll(".comment-item-sub");

        subs.forEach(el => {

          let raw = txt(el.querySelector(".content"));

          let replyTo = null;
          let text = raw;

          if (raw.startsWith("回复")) {
            let m = raw.match(/^回复\s+(.+?)\s*:\s*(.*)$/);
            if (m) {
              replyTo = m[1];
              text = m[2];
            }
          }

          replies.push({
            user: txt(el.querySelector(".name")),
            replyTo,
            text,
            time: txt(el.querySelector(".date span")),
            location: txt(el.querySelector(".location")),
            images: getImages(el)
          });
        });
      }

      items.push({
        index: i + 1,
        comment,
        replies
      });
    });

    return items;
  }

  /***********************
   * 主流程
   ***********************/
  async function run(btn) {

    btn.innerText = "抓取中...";

    const scroller = getScroller();

    await scrollToEnd(scroller);
    await expandAll();
    await scrollToEnd(scroller);
    await expandAll();
    await waitStable(scroller);

    const items = parseAll();

    // ⭐统计增强
    const mainCount = items.length;
    const replyCount = items.reduce((s, i) => s + i.replies.length, 0);
    const totalCount = mainCount + replyCount;

    const result = {
      url: location.href,
      mainCount,
      replyCount,
      totalCount,
      items
    };

    const blob = new Blob(
      [JSON.stringify(result, null, 2)],
      { type: "application/json" }
    );

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "xhs_comments_" + Date.now() + ".json";
    a.click();

    btn.innerText = "导出评论";

    console.log("完成:", result);
  }

  /***********************
   * 插入按钮
   ***********************/
  function injectBtn() {

    if (document.getElementById("xhs-export-btn")) return;

    const btn = document.createElement("button");
    btn.id = "xhs-export-btn";
    btn.innerText = "导出评论";

    btn.style.cssText = `
      position: fixed;
      right: 20px;
      bottom: 120px;
      z-index: 999999;
      padding: 12px 18px;
      background: #ff2442;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      font-size: 14px;
    `;

    btn.onclick = () => run(btn);

    document.body.appendChild(btn);

    console.log("按钮已出现");
  }

  /***********************
   * 监听评论区
   ***********************/
  setInterval(() => {
    if (document.querySelector(".comments-container")) {
      injectBtn();
    }
  }, 800);

})();