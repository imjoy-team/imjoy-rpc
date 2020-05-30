![License](https://img.shields.io/github/license/imjoy-team/imjoy-rpc.svg)
![Build ImJoy RPC](https://github.com/imjoy-team/imjoy-rpc/workflows/Build%20ImJoy%20RPC/badge.svg)
![PyPI](https://img.shields.io/pypi/v/imjoy-rpc.svg?style=popout)

# ImJoy RPC

Symmetrical Transparent Remote Procedure Calls

The core library that powers [ImJoy](https://imjoy.io).

### Python library
```bash
pip install imjoy-rpc
```

### Javascript library

#### NPM
```
npm install imjoy-rpc
```

```js
import * as imjoyRPC from 'imjoy-rpc';

imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
```

#### Browser

```html
<script src="https://cdn.jsdelivr.net/npm/imjoy-rpc@latest/dist/imjoy-rpc.min.js"></script>
<script>
imjoyRPC.setupRPC({name: 'My Awesome App'}).then((api)=>{
 // call api.export to expose your plugin api
})
</script>
```


### [Jupyter notebook extension](./nbextension/README.md)

## imjoy-rpc handshaking protocol

To start a connection between the core and an rpc peer (a plugin), a handshaking process is required to exchange the api. For the rpc peer, it works like a service provider that takes a set of api from the core and produce a set of service functions. The handshaking defines the exchange of interface functions, as well as authentication and configuration.

Here is a schema illustrate the process: 
[imjoy-rpc handshaking protocol](https://docs.google.com/drawings/d/13aZQxh-JNSILyHZXR8q3WmeL9gVAC3tvvffi1TOoIok/edit?usp=sharing)

## Data type representation

ImJoy RPC is built on top of two-way transport layer(currently only support [Jupyter comm messages](https://jupyter-notebook.readthedocs.io/en/stable/comms.html)). Data with different types are encoded into a unified represention and send over the transport layer. It will then be decoded into the same or corresponding data type on the otherside.

The data representation is a JSON object (but can contain binary data, e.g. `ArrayBuffer` in JS or `bytes` in Python). The goal is to represent more complex data types with primitive types that are commonly supported by many programming language, including strings, numbers, boolean, bytes, list/array and dictionary/object.


| Javascript | Python | imjoy-rpc representation |
|------------|--------- | ---- |
| String   | str        | v |
| Number   | int/float | v |
| Boolean  |  bool     | v |
| null/undefined  | None    | v |
| ArrayBuffer | bytes  | v |
| Array([])   | list/tuple |[_encode(v)] |
| Object({})  | dict  | {_encode(v)} |
| Set | Set | {_rtype: "set", _rvalue: _encode(Array.from(v))} |
| Map | OrderedDict  |{_rtype: "orderedmap", _rvalue: _encode(Array.from(v))} |
| Error | Exception | { _rtype: "error", _rvalue: v.toString() } |
| Blob | BytesIO/StringIO  | { _rtype: "blob", _rvalue: v, _rmime: v.type } |
| DataView | memoryview  |  { _rtype: "memoryview", _rvalue: v.buffer }|
| TypedArray | 1-D numpy array*  |{_rtype: "typedarray", _rvalue: v.buffer, _rdtype: dtype} |
| tf.Tensor/nj.array | numpy array  |{_rtype: "ndarray", _rvalue: v.buffer, _rshape: shape, _rdtype: _dtype} |
| Function* | function/callable* | {_rtype: "interface", _rid: _rid, _rvalue: name} <br> {_rtype: "callback", _rvalue: id} |
| Class | class/dotdict()* | {...} |
| custom | custom | {_rtype: "custom", _rvalue: _rpc_encode(v), _rid: _rid}

Notes:
 - `_encode(...)` in the imjoy-rpc representation means the type will be recursively encoded (decoded).
 - For any JS object or Python dictonary, if it has a key named `_rintf` and the value is set to true, then this object will be treated as an interface. All functions contained in the object/dictionary, including all the children dictionary at any level, will be treated as `interface` function. Otherwise, it will be encoded as `callback`. The difference is `interface` function can be called many times, but the `callback` function can only be called once (Also see "Remote Objects" below).
 - For n-D numpy array, there is no established n-D array library in javascript, the current behavior is, if there is `tf`(Tensorflow.js) detected, then it will be decoded into `tf.Tensor`. If `nj`(numjs) is detected, then it will be decoded into `nj.array`.
 - Typed array will be represented as numpy array if available, otherwise it will be converted to raw bytes.    
    Type Conversion
    | Javascript | Numpy  | _rdtype |
    | -- | -- | -- |
    | Int8Array | int8 | int8 |
    | Int16Array| int16 |int16 |
    |  Int32Array| int32 | int32 |
    |  Uint8Array| uint8 | uint8 |
    |  Uint16Array| uint16 | uint16 |
    |  Uint32Array| uint32 | uint32 |
    |  Float32Array| float32 | float32 |
    |  Float64Array| float64 | float64 |
    |  Array| array | array |
    |note: 64-bit integers (signed or unsigned) are not supported|

 - `dotdict` in Python is a simple wrapper over `dict` that support using the dot notation to get item, similar to what you can do with Javascript object.

 ## Encoding and decoding custom objects
 For the data or object types that are not in the table above, for example, a custom class, you can send it by defining `export_api._rpc_encode()` and `export_api._rpc_decode()` in the api exported from the plugin. 
 
 The basic idea is to use `_rpc_encode` function to represent your custom data type into array/dictionary of primitive types (string, number etc.) such that they can be send via imjoy-rpc. Then use `_rpc_decode` to reconstruct the object remotely based on the representation.

In the `_rpc_encode` and `_rpc_decode`, you can use if statement to check if you can encode or decode the object, otherwise the value will be left undecoded/encoded. 

Inside `_rpc_encode`, you need to specify a custom type name with the `_ctype` key and return the represented object/dictionary. Note that, you can only use primitive types plus array/list and object/dict in the represented object. If no `_ctype` key is detected in the returned object, imjoy-rpc will assume you have transformed the object (e.g. applied compression), and apply internal encoding to the transformed object.

In `_rpc_decode`, you can then check the `_ctype` key, apply the corresponding decoding procedure and return the decoded object. In some cases, you may want to simply transform the object and pass it to imjoy-rpc for decoding. For example, to decompress the object, you can return an object with the `_rtype` key, and make sure the object is represented one of the format listed in the table above.

See an example below:

```javascript
class Cat{
    constructor(name, color, age){
        this.name = name
        this.color = color
        this.age = age
    }
}

class Plugin {
    _rpc_encode(obj){
        if(obj instanceof Cat){
        return {_ctype: 'cat', name: obj.name, color: obj.color, age: obj.age}
        }
    }
    _rpc_decode(encoded_obj){
        if(encoded_obj._ctype === 'cat'){
        return new Cat(encoded_obj.name, encoded_obj.color, encoded_obj.age)
        }
    }
    async run(){
        const bobo = new Cat('boboshu', 'mixed', 0.67)
        // assuming we have a shower plugin
        const showerPlugin = await api.getPlugin('catShower')
        // now pass bobo into the shower plugin, and we should get a clean cat, the name should be still bobo
        // note that the other plugin is running in another sandboxed iframe or in Python
        // because we have the custom encoding/decoding, we can send the Cat object to the other plugin
        // Also notice that the other plugin should also define custom encoding decoding following the same representation
        const cleanCat = await showerPlugin.wash(bobo)
        api.alert(cleanCat.name + ' was happily washed in the shower.')
    }
};
api.export(new Plugin())
```

Note that, you need to implement the same encoding and decoding for the two connection peers.


## Remote Objects

When sending an object (a JS `Object`, `Class` or Python `dict`, `class`) remotely via imjoy-rpc, a proxy object will be created on the other side. The object can contain supported data types which will be send directly to remote locations.

Specifically for the methods contained in the object, there are two types of encoding modes (`interface` and `callback`). The difference is that a remote method encoded as `callback` can only be called once and will be destroied after calling, and `interface` mode can be used without this limitation. 

The two types can be switched automatically or manually:
 * if the object contains a key or property: `_rintf` and the value is true, then all the member function will be treated as `interface` recursively.
 * if the object is not a basic `Object`/`array` or `dict`/`list` but other general class, then it will be treated as `interface`.

Note: if a method's name starts with `_`, it will not be sent and mapped remotely.

Importantly, When an object is sent to remote location, the object will be stored in an internal object store. Because the object store will always hold object, it will not be possible for the gabage collector to recycle the resources. To get rid of this issue, you need to dispose the remote object manually by calling `api.disposeObject(obj)` function. This will notify the remote peer to remove the object from the object store, such that the gababe collector can then collect the occupied resources.

**Therefore, please always call `api.disposeObject(obj)` when you don't need a remote object anymore.** This is necessary only for those object encoded in `interface` mode.