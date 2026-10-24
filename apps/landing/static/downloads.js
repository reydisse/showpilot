// Download buttons stay inert until the Worker confirms a published R2
// release. This prevents private GitHub links and half-uploaded artifacts
// from becoming public 404s.
(function () {
  var buttons = Array.prototype.slice.call(
    document.querySelectorAll("[data-download-id]"),
  );
  if (!buttons.length) return;

  buttons.forEach(function (button) {
    button.addEventListener("click", function (event) {
      if (button.getAttribute("aria-disabled") === "true")
        event.preventDefault();
    });
  });

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "DOWNLOAD";
    return (
      (bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1) + " MB"
    );
  }

  fetch("/downloads/manifest.json", { headers: { Accept: "application/json" } })
    .then(function (response) {
      if (!response.ok) throw new Error("release manifest unavailable");
      return response.json();
    })
    .then(function (manifest) {
      var releases = Array.isArray(manifest.releases) ? manifest.releases : [];
      var byId = new Map(
        releases.map(function (release) {
          return [release.id, release];
        }),
      );
      buttons.forEach(function (button) {
        var release = byId.get(button.getAttribute("data-download-id"));
        var meta = button.querySelector("small");
        if (!release || typeof release.downloadUrl !== "string") {
          if (meta) meta.textContent = "NOT YET PUBLIC";
          return;
        }
        button.href = release.downloadUrl;
        button.classList.remove("is-unavailable");
        button.removeAttribute("aria-disabled");
        if (meta)
          meta.textContent =
            String(release.version).toUpperCase() +
            " · " +
            (release.kind === "store"
              ? release.platform === "iOS"
                ? "APP STORE"
                : "GOOGLE PLAY"
              : formatBytes(release.size));
      });
      ["desktop", "bridge", "mobile"].forEach(function (product) {
        var available = releases.filter(function (release) {
          return (
            release.product === product &&
            buttons.some(function (button) {
              return button.getAttribute("data-download-id") === release.id;
            })
          );
        });
        var status = document.querySelector(
          '[data-product-status="' + product + '"]',
        );
        if (!status) return;
        if (!available.length) {
          status.textContent = "NOT YET PUBLIC";
          return;
        }
        var statuses = Array.from(
          new Set(
            available.map(function (release) {
              return String(release.status).toUpperCase();
            }),
          ),
        );
        var versions = Array.from(
          new Set(
            available.map(function (release) {
              return String(release.version).toUpperCase();
            }),
          ),
        );
        status.textContent =
          (statuses.length === 1 ? statuses[0] : "AVAILABLE") +
          (versions.length === 1 ? " · " + versions[0] : "");
      });
    })
    .catch(function () {
      document
        .querySelectorAll("[data-product-status]")
        .forEach(function (status) {
          status.textContent = "STATUS UNAVAILABLE";
        });
      buttons.forEach(function (button) {
        var meta = button.querySelector("small");
        if (meta) meta.textContent = "CHECK BACK SOON";
      });
    });
})();
