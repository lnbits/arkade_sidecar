{
  description = "Arkade L2 sidecar (LNbits sidecar)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        pname = "lnbits-arkade-sidecar";
        version = "0.0.0";

        package = pkgs.buildNpmPackage {
          inherit pname version;
          src = ./.;
          npmDepsHash = "";

          dontNpmBuild = true;
          dontBuild = true;

          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib/node_modules/${pname}
            cp -r . $out/lib/node_modules/${pname}
            runHook postInstall
          '';
        };

        runSidecar = pkgs.writeShellApplication {
          name = "arkade-sidecar";
          runtimeInputs = [ pkgs.nodejs_22 ];
          text = ''
            export NODE_PATH=${package}/lib/node_modules/${pname}/node_modules
            exec ${pkgs.nodejs_22}/bin/node ${package}/lib/node_modules/${pname}/server.mjs
          '';
        };
      in
      {
        packages.default = package;
        apps.default = flake-utils.lib.mkApp { drv = runSidecar; };
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 pkgs.nodePackages.npm ];
        };
      });
}
