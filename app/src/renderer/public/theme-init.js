;(function () {
  var theme = localStorage.getItem('tuanzi.desktop.theme.v1')
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  }
})()
