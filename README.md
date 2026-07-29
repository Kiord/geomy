


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
```
npm install
npm run dev
``` 

### Publishing a release

Create releases from a clean default branch with:

```sh
git commit -m "Release X.X.X"
npm.cmd run build
npm version X.X.X
git push origin HEAD --follow-tags
```


### Implemented tasks
- 3D inspection
- Landmarking
- Vertex masking
- Vertex segmentation
- Rigid align
