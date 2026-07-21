```
npm version X.X.X --no-git-tag-version
git commit -m "Release X.X.X"
npm.cmd run build
git tag -a vX.X.X -m "vX.X.X"
git push origin main
git push origin vX.X.X
```

