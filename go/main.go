package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"path"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/pkg/errors"
	"github.com/kaspanet/kaspad/app/appmessage"
	"github.com/kaspanet/kaspad/infrastructure/network/rpcclient"
	"golang.org/x/net/context"
	"gopkg.in/yaml.v2"
)

type KaspaApi struct {
	address       string
	blockWaitTime time.Duration
	kaspad        *rpcclient.RPCClient
	connected     bool
}

func NewKaspaAPI(address string, blockWaitTime time.Duration) (*KaspaApi, error) {
	client, err := rpcclient.NewRPCClient(address)
	if err != nil {
		return nil, err
	}

	return &KaspaApi{
		address:       address,
		blockWaitTime: blockWaitTime,
		kaspad:        client,
		connected:     true,
	}, nil
}

type BridgeConfig struct {
	RPCServer     string        `yaml:"kaspad_address"`
	BlockWaitTime time.Duration `yaml:"block_wait_time"`
	RedisAddress  string        `yaml:"redis_address"`
	RedisChannel  string        `yaml:"redis_channel"`
}

func (ks *KaspaApi) GetBlockTemplate() (*appmessage.GetBlockTemplateResponseMessage, error) {
	template, err := ks.kaspad.GetBlockTemplate("kaspa:qyppkat8emnevrdtnu4hkkc6dmwj4xwmfh9ne3ncng49azgta7sg0ncrthn2erh",
		fmt.Sprintf(`'%s' via onemorebsmith/kaspa-stratum-bridge_%s`, "GodMiner/2.0.0", "v1.2.1"))

	if err != nil {
		return nil, errors.Wrap(err, "failed fetching new block template from kaspa")
	}
	return template, nil
}

func main() {
	// Load configuration
	pwd, _ := os.Getwd()
	fullPath := path.Join(pwd, "config.yaml")
	log.Printf("loading config @ `%s`", fullPath)
	rawCfg, err := ioutil.ReadFile(fullPath)
	if err != nil {
		log.Printf("config file not found: %s", err)
		os.Exit(1)
	}

	cfg := BridgeConfig{}
	if err := yaml.Unmarshal(rawCfg, &cfg); err != nil {
		log.Printf("failed parsing config file: %s", err)
		os.Exit(1)
	}
	fmt.Printf("%v", cfg)

	// Initialize Kaspa API
	ksApi, err := NewKaspaAPI(cfg.RPCServer, cfg.BlockWaitTime)
	if err != nil {
		log.Fatalf("failed to initialize Kaspa API: %v", err)
	}

	// Initialize Redis client
	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{
		Addr: cfg.RedisAddress,
	})
	defer rdb.Close()

	// Test Redis connection
	_, err = rdb.Ping(ctx).Result()
	if err != nil {
		log.Fatalf("could not connect to Redis: %v", err)
	}

	var templateMutex sync.Mutex
	var currentTemplate *appmessage.GetBlockTemplateResponseMessage

	// Start a goroutine to continuously fetch block templates and publish them to Redis
	go func() {
		for {
			template, err := ksApi.GetBlockTemplate()
			if err != nil {
				log.Printf("error fetching block template: %v", err)
				time.Sleep(ksApi.blockWaitTime)
				continue
			}

			// Safely store the template
			templateMutex.Lock()
			currentTemplate = template
			templateMutex.Unlock()

			// Serialize the template to JSON
			templateJSON, err := json.Marshal(template)
			if err != nil {
				log.Printf("error serializing template to JSON: %v", err)
				continue
			}

			// Publish the JSON to Redis
			err = rdb.Publish(ctx, cfg.RedisChannel, templateJSON).Err()
			if err != nil {
				log.Printf("error publishing to Redis: %v", err)
			} else {
				log.Printf("template published to Redis channel %s", cfg.RedisChannel)
			}

			time.Sleep(ksApi.blockWaitTime)
		}
	}()

	// Output block template in the main function
	for {
		time.Sleep(5 * time.Second) // Adjust the frequency of logging as needed

		templateMutex.Lock()
		if currentTemplate != nil {
			fmt.Printf(`
HashMerkleRoot        : %v
AcceptedIDMerkleRoot  : %v
UTXOCommitment        : %v
Timestamp             : %v
Bits                  : %v
Nonce                 : %v
DAAScore              : %v
BlueWork              : %v
BlueScore             : %v
PruningPoint          : %v
Transactions Length   : %v
---------------------------------------
`,
				currentTemplate.Block.Header.HashMerkleRoot,
				currentTemplate.Block.Header.AcceptedIDMerkleRoot,
				currentTemplate.Block.Header.UTXOCommitment,
				currentTemplate.Block.Header.Timestamp,
				currentTemplate.Block.Header.Bits,
				currentTemplate.Block.Header.Nonce,
				currentTemplate.Block.Header.DAAScore,
				currentTemplate.Block.Header.BlueWork,
				currentTemplate.Block.Header.BlueScore,
				currentTemplate.Block.Header.PruningPoint,
				len(currentTemplate.Block.Transactions),
			)
		} else {
			fmt.Println("No block template fetched yet.")
		}
		templateMutex.Unlock()
	}
}
