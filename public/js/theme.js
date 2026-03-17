(() => {
  // <stdin>
  function toggleTheme() {
    if (document.documentElement.className.includes("dark")) {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    } else {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    }
  }
  window.addEventListener("DOMContentLoaded", (event) => {
    const switcher = document.getElementById("theme-switcher");
    if (switcher) {
      switcher.addEventListener("click", () => {
        toggleTheme();
      });
    }
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event2) => {
      if (event2.matches && localStorage.getItem("theme") === "light") {
        toggleTheme();
      }
    });
  });
})();
