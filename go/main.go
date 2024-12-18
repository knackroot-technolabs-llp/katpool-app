package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/go-redis/redis/v8"
	"github.com/joho/godotenv"
	"github.com/kaspanet/kaspad/app/appmessage"
	"github.com/kaspanet/kaspad/cmd/kaspawallet/libkaspawallet"
	"github.com/kaspanet/kaspad/infrastructure/network/rpcclient"
	"github.com/kaspanet/kaspad/util"
	"github.com/pkg/errors"
	"golang.org/x/net/context"
)

type KaspaApi struct {
	address       string
	blockWaitTime time.Duration
	kaspad        *rpcclient.RPCClient
	connected     bool
}

type BridgeConfig struct {
	RPCServer        []string `json:"node"`
	Network 		 string   `json:"network"`
	BlockWaitTimeSec string   `json:"block_wait_time_seconds"`
	RedisAddress     string   `json:"redis_address"`
	RedisChannel     string   `json:"redis_channel"`
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

func fetchKaspaAccountFromPrivateKey(network, privateKeyHex string) (string, error) {
	prefix := util.Bech32PrefixKaspa
	if network == "testnet-10" {
		prefix = util.Bech32PrefixKaspaTest
	}

	privateKeyBytes, err := hex.DecodeString(privateKeyHex)
	if err != nil {
		return "", err
	}

	publicKeybytes, err := libkaspawallet.PublicKeyFromPrivateKey(privateKeyBytes)
	if err != nil {
		return "", err
	}

	addressPubKey, err := util.NewAddressPublicKey(publicKeybytes, prefix)
	if err != nil {
		return "", err
	}

	address, err := util.DecodeAddress(addressPubKey.String(), prefix)
	if err != nil {
		return "", err
	}

	return address.EncodeAddress(), nil
}

func (ks *KaspaApi) GetBlockTemplate(miningAddr string) (*appmessage.GetBlockTemplateResponseMessage, error) {
	template, err := ks.kaspad.GetBlockTemplate(miningAddr,
		"Katpool")

	if err != nil {
		return nil, errors.Wrap(err, "failed fetching new block template from kaspa")
	}
	return template, nil
}

func main() {
	// Step 1: Load .env file
	err := godotenv.Load("../.env")
	if err != nil {
		log.Fatalf("Error loading .env file: %v", err)
	}

	// Step 2: Read environment variables
	privateKey := os.Getenv("TREASURY_PRIVATE_KEY")

	// Open the JSON file
	file, err := os.Open("../config/config.json")
	if err != nil {
		fmt.Printf("Error opening file: %v\n", err)
		return
	}
	defer file.Close()

	// Decode JSON into the struct
	var config BridgeConfig
	decoder := json.NewDecoder(file)
	err = decoder.Decode(&config)
	if err != nil {
		fmt.Printf("Error decoding JSON: %v\n", err)
		return
	}
	log.Println("Config : %v", config)

	address, err := fetchKaspaAccountFromPrivateKey(config.Network, privateKey)
	if err != nil {
		log.Fatalf("failed to retrieve address from private key : %v", err)
	}
	log.Println("Address : ", address)

	// Initialize Kaspa API
	num, err := strconv.Atoi(config.BlockWaitTimeSec)
	if err != nil {
		fmt.Println("Error: Invalid BlockWaitTimeSec : ", err)
		return
	}

	ksApi, err := NewKaspaAPI(config.RPCServer[0], time.Duration(num))
	if err != nil {
		log.Fatalf("failed to initialize Kaspa API: %v", err)
	}

	// Initialize Redis client
	ctx := context.Background()
	rdb := redis.NewClient(&redis.Options{
		Addr: config.RedisAddress,
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
			template, err := ksApi.GetBlockTemplate(address)
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
			err = rdb.Publish(ctx, config.RedisChannel, templateJSON).Err()
			if err != nil {
				log.Printf("error publishing to Redis: %v", err)
			} else {
				log.Printf("template published to Redis channel %s", config.RedisChannel)
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
