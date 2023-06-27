export interface MessageEmitter {
  emit: (event: any) => void;
  on(event: string, handler: Function): void;
  once(event: string, handler: Function): void;
  off(event: string, handler?: Function): void;
}

interface RPC extends MessageEmitter {
  init(): void;
  setConfig(config: any): void;
  getRemoteCallStack(): any;
  getRemote(): any;
  setInterface(_interface: any, config?: any): Promise<void>;
  sendInterface(): void;
  disposeObject(obj: any): Promise<void>;
  requestRemote(): void;
  reset(): void;
  disconnect(): void;
}

interface hRPC extends MessageEmitter {
  register_codec(config: any): void;
  ping(client_id: any, timeout: any): Promise<any>;
  reset(): void;
  disconnect(): Promise<void>;
  get_manager_service(timeout: any): Promise<void>;
  get_all_local_services(): any;
  get_local_service(service_id: any, context: any): any;
  get_remote_service(service_uri: any, timeout?: any): Promise<any>;
  add_service(api: any, overwrite?: any): any;
  register_service(
    api: any,
    overwrite?: any,
    notify?: any,
    context?: any
  ): Promise<any>;
  unregister_service(service: any, notify?: any): Promise<void>;
  get_client_info(): any;
  encode(aObject: any, session_id: any): any;
  decode(aObject: any): Promise<any>;
}

interface ServerConfig {
  server_url: string;
  client_id?: string;
  workspace?: string;
  token?: string;
  method_timeout?: number;
  name?: string;
}

interface LoginConfig {
  server_url: string;
  login_service_id?: string;
  login_timeout?: string;
  login_callback?: Function;
}

interface API {
  id: string;
  name: string;
}

declare module "imjoy-rpc" {
  const imjoyRPCModule: {
    imjoyRPC: {
      RPC: string;
      API_VERSION: string;
      VERSION: string;
      loadRequirements: (config: any) => Promise<any>;
      waitForInitialization: (config: any) => void;
      setupRPC: (config: any) => Promise<any>;
    },
    imjoyRPCSocketIO: {
      RPC: any;
      API_VERSION: string;
      VERSION: string;
      loadRequirements: (config: any) => Promise<any>;
      waitForInitialization: (config: any) => void;
      setupRPC: (config: any) => Promise<any>;
      Connection: any;
      connectToServer: (config: any) => Promise<any>;
    };
    hyphaRPC: {
      API_VERSION: string;
      RPC: hRPC;
    };
    hyphaWebsocketClient: {
      RPC: hRPC;
      API_VERSION: string;
      VERSION: string;
      loadRequirements: (config: any) => Promise<any>;
      login: (config: LoginConfig) => Promise<any>;
      connectToServer: (config: ServerConfig) => Promise<any>;
    };
  };

  export = imjoyRPCModule;
}
