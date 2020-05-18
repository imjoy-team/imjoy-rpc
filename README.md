![License](https://img.shields.io/github/license/imjoy-team/imjoy-rpc.svg)
![Build ImJoy RPC](https://github.com/imjoy-team/imjoy-rpc/workflows/Build%20ImJoy%20RPC/badge.svg)
![PyPI](https://img.shields.io/pypi/v/imjoy-rpc.svg?style=popout)

# ImJoy RPC

Symmetrical Transparent Remote Procedure Calls

The core library that powers [ImJoy](https://imjoy.io).

## Python
```bash
pip install imjoy-rpc
```

## Javascript

### NPM
```
npm install imjoy-rpc
```

```js
import * as imjoyRPC from 'imjoy-rpc';

imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
```

### Browser

```html
<script src="https://cdn.jsdelivr.net/npm/imjoy-rpc@latest/dist/imjoy-rpc.min.js"></script>
<script>
imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
</script>
```