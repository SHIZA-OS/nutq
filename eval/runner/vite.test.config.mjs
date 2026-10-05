// Vite config for the test and eval drivers (startVite in vite-server.mjs): the app's index.html, without its Google Fonts links.
// Those only style the page, but they block the page's load event, so on a slow or missing network every page.goto waits
// for them (and times out when many browsers start at once). Nothing under test needs them.
export default {
  plugins: [
    {
      name: "no-external-fonts",
      transformIndexHtml: (html) => html.replace(/<link[^>]*(fonts\.googleapis\.com|fonts\.gstatic\.com)[^>]*>\s*/g, ""),
    },
  ],
};
