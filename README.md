


<p align="center">
<picture >
  <img alt="Fallback image description" src="https://geomy.gker.fr/logo.svg" width=128>
</picture>
  <br>
  A 3D mesh toolbox in your browser
</p>

### Access online

click [here](https://geomy.gker.fr)

### Install and run locally 

The hosted app remains the main way to use Geomy. For development:

```
npm install
npm run dev
``` 

Run the unit tests with:

```sh
npm test
```

### Run as a desktop application

Download the file for your system from the latest GitHub release:

- Windows: `Geomy_*_portable.exe` runs directly, or `Geomy_*_setup.exe`
  installs Geomy for the current user.
- Linux: make `Geomy_*.AppImage` executable with `chmod +x`, then run it.
- macOS: open `Geomy_*.dmg` and drag Geomy into Applications.

The Windows builds use the Microsoft Edge WebView2 runtime included with current
Windows 10 and Windows 11 installations. The installer can download WebView2 when
it is missing.

Desktop development additionally requires Rust and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
npm install
npm run desktop:dev
npm run desktop:build
```

### Publishing a release

Create releases from a clean default branch with:

```sh
npm version X.X.X
git push origin HEAD --follow-tags
```

The npm version command updates the web and desktop versions together. Pushing the
tag deploys the hosted site and publishes the website ZIP plus Windows, Linux, and
macOS desktop downloads to the GitHub release.


### Implemented tasks
- 3D inspection
- Landmarking
- Vertex masking
- Vertex segmentation
- Rigid align
