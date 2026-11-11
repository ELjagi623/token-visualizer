(function () {
  try {
    var pref = localStorage.getItem('tv.theme');
    if (pref !== 'light' && pref !== 'dark') pref = 'system';
    var dark = pref === 'dark' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.style.colorScheme = dark ? 'dark' : 'light';
    // 等服务端设置回来再显示（见 base.css）；超时兜底，服务不可用时也不会一直空白
    root.setAttribute('data-theme-pending', '');
    setTimeout(function () {
      root.removeAttribute('data-theme-pending');
    }, 1200);
  } catch (e) {
    /* 本地存储不可用时保持默认浅色 */
  }
})();
