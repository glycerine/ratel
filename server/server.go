package server

import (
	"bytes"
	"flag"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"os"
	"strings"
)

const (
	ratelVersion = "1.0.0"

	defaultPort = 8081
	defaultAddr = ""

	clientBuildStaticPath = "./client/build/static"

	indexPath = "index.html"
)

var (
	devMode bool
	addr    string
	port    int

	indexContent *content
)

// Run starts the server.
func Run() {
	parseFlags()
	setIndexContent()

	if devMode {
		fs := http.FileServer(http.Dir(clientBuildStaticPath))
		http.Handle("/cdn/static/", http.StripPrefix("/cdn/static/", fs))
	}
	http.HandleFunc("/", mainHandler)

	log.Println(fmt.Sprintf("Listening on port %d...", port))
	log.Fatalln(http.ListenAndServe(fmt.Sprintf(":%d", port), nil))
}

func parseFlags() {
	devModePtr := flag.Bool(
		"dev",
		false,
		fmt.Sprintf("Run ratel in dev mode (requires %s with all the necessary assets).", clientBuildStaticPath),
	)
	portPtr := flag.Int("p", defaultPort, "Port on which the ratel server will run.")
	addrPtr := flag.String("addr", defaultAddr, "Address of the Dgraph server.")
	version := flag.Bool("version", false, "Prints the version of ratel.")

	flag.Parse()

	if *version {
		fmt.Printf("Ratel Version: %s\n", ratelVersion)
		os.Exit(0)
	}

	var err error
	addr, err = validateAddr(*addrPtr)
	if err != nil {
		fmt.Printf("Error parsing Dgraph server address: %s\n", err.Error())
		os.Exit(1)
	}

	devMode = *devModePtr
	port = *portPtr
}

func setIndexContent() {
	bs, err := Asset(indexPath)
	if err != nil {
		panic(fmt.Sprintf("error retrieving \"%s\" asset", indexPath))
	}

	info, err := AssetInfo(indexPath)
	if err != nil {
		panic(fmt.Sprintf("error retrieving \"%s\" asset info", indexPath))
	}

	tmpl, err := template.New(indexPath).Parse(string(bs))
	if err != nil {
		panic(fmt.Sprintf("error parsing \"%s\" contents", indexPath))
	}

	buf := bytes.NewBuffer([]byte{})
	err = tmpl.Execute(buf, addr)
	if err != nil {
		panic(fmt.Sprintf("error executing \"%s\" template", indexPath))
	}

	indexContent = &content{
		name:    info.Name(),
		modTime: info.ModTime(),
		bs:      buf.Bytes(),
	}
}

func mainHandler(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if strings.HasPrefix(path, "/") {
		path = path[1:]
	}

	if path == "" || path == indexPath {
		indexContent.serve(w, r)
		return
	}

	bs, err := Asset(path)
	if err != nil {
		http.Error(w, "resource not found", http.StatusNotFound)
		return
	}

	info, err := AssetInfo(path)
	if err != nil {
		http.Error(w, "resource not found", http.StatusNotFound)
		return
	}

	http.ServeContent(w, r, info.Name(), info.ModTime(), newBuffer(bs))
}
