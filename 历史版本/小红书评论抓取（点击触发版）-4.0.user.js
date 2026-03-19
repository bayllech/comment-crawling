// ==UserScript==
// @name         小红书评论抓取（点击触发版）
// @namespace    http://tampermonkey.net/
// @version      4.0
// @match        https://www.xiaohongshu.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  /***********************
   * 滚动到底
   ***********************/
  async function scrollToEnd(scroller) {

    console.log("开始滚动");

    for (let i = 0; i < 200; i++) {

      scroller.scrollTop = scroller.scrollHeight;
      await sleep(1000);

      if (document.querySelector(".end-container")) {
        console.log("已到 THE END");
        break;
      }
    }
  }

  /***********************
   * 展开所有评论
   ***********************/
  async function expandAll() {

    console.log("展开回复");

    for (let i = 0; i < 100; i++) {

      let btns = Array.from(document.querySelectorAll("*"))
        .filter(el => (el.innerText || "").includes("展开"));

      if (!btns.length) break;

      for (let b of btns) {
        try { b.click(); } catch(e){}
        await sleep(200);
      }

      await sleep(800);
    }
  }

  /***********************
   * 解析
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
   * 主流程（点击触发）
   ***********************/
  async function run() {

    const btn = document.getElementById("xhs-export-btn");
    btn.innerText = "抓取中...";

    const scroller = getScroller();

    await scrollToEnd(scroller);
    await expandAll();
    await scrollToEnd(scroller);

    const items = parseAll();

    const result = {
      url: location.href,
      total: items.length,
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

    console.log("完成:", items.length);
  }

  /***********************
   * 插入按钮（立即出现）
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

    btn.onclick = run;

    document.body.appendChild(btn);

    console.log("按钮已出现");
  }

  /***********************
   * 监听浮窗打开
   ***********************/
  setInterval(() => {

    if (document.querySelector(".comments-container")) {
      injectBtn();
    }

  }, 800);

})();